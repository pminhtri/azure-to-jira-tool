import { join } from "node:path";
import { ensureDir, exists } from "../util/fsx.ts";
import type { Config } from "../config.ts";
import { log, Progress } from "../log.ts";
import { chunk, pool } from "../util/pool.ts";
import { AdoClient } from "./client.ts";
import { flattenIterations } from "./iterations.ts";
import type {
  AdoWorkItem,
  AttachmentManifestEntry,
  ExportedWorkItem,
  ExportManifest,
  FlatIteration,
} from "./types.ts";

export interface ExportOptions {
  /** Skip work items that already have a file on disk. */
  resume: boolean;
  /** Export only these ids (debugging). */
  only?: number[];
  /** Cap the number of work items (smoke test). */
  limit?: number;
  /** GUID or path of a saved ADO query, used instead of the generated WIQL. */
  query?: string;
}

/** Canonical paths inside DATA_DIR. */
export class DataLayout {
  constructor(readonly root: string) {}
  get manifest() {
    return join(this.root, "manifest.json");
  }
  get project() {
    return join(this.root, "project.json");
  }
  get iterations() {
    return join(this.root, "iterations.json");
  }
  get iterationTree() {
    return join(this.root, "iterations.tree.json");
  }
  get areaTree() {
    return join(this.root, "areas.tree.json");
  }
  get teams() {
    return join(this.root, "teams.json");
  }
  workItem(id: number) {
    return join(this.root, "workitems", String(Math.floor(id / 1000)), `${id}.json`);
  }
  attachmentDir(workItemId: number) {
    return join(this.root, "attachments", String(workItemId));
  }

  async readWorkItem(id: number): Promise<ExportedWorkItem | null> {
    try {
      return JSON.parse(await Deno.readTextFile(this.workItem(id))) as ExportedWorkItem;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }

  async readManifest(): Promise<ExportManifest> {
    try {
      return JSON.parse(await Deno.readTextFile(this.manifest)) as ExportManifest;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(`No exported data at ${this.root}. Run \`deno task export\` first.`);
      }
      throw err;
    }
  }

  async readIterations(): Promise<FlatIteration[]> {
    return JSON.parse(await Deno.readTextFile(this.iterations)) as FlatIteration[];
  }
}

const ATTACHMENT_GUID = /\/_apis\/wit\/attachments\/([0-9a-fA-F-]{36})/;

/** Run the full export phase from Azure DevOps to disk. */
export async function runExport(cfg: Config, opts: ExportOptions): Promise<ExportManifest> {
  const ado = new AdoClient(cfg);
  const layout = new DataLayout(cfg.dataDir);
  await ensureDir(cfg.dataDir);

  log.header("Azure DevOps → local export");
  const project = await ado.verifyAccess();
  log.ok(`Connected to ADO: ${cfg.ado.org}/${project.name} (${project.id})`);
  await Deno.writeTextFile(layout.project, JSON.stringify(project, null, 2));

  // -- Project structure: iterations, areas, teams -------------------------
  log.step("Export iterations / areas / teams");
  const [iterationTree, areaTree, teams] = await Promise.all([
    ado.getClassificationNodes("iterations"),
    ado.getClassificationNodes("areas"),
    ado.getTeams(),
  ]);
  await Deno.writeTextFile(layout.iterationTree, JSON.stringify(iterationTree, null, 2));
  await Deno.writeTextFile(layout.areaTree, JSON.stringify(areaTree, null, 2));

  // Team iterations give the precise sprint start/finish dates.
  const teamIterations = await pool(teams, cfg.concurrency, async (team) => ({
    team,
    iterations: await ado.getTeamIterations(team.id),
  }));
  await Deno.writeTextFile(layout.teams, JSON.stringify(teamIterations, null, 2));

  const iterations = flattenIterations(iterationTree, teamIterations.flatMap((t) => t.iterations));
  await Deno.writeTextFile(layout.iterations, JSON.stringify(iterations, null, 2));
  log.ok(`${iterations.length} iterations, ${teams.length} teams, ${countNodes(areaTree)} area paths`);

  // -- Work item list ------------------------------------------------------
  let parentFromQuery: Map<number, number> | null = null;
  let ids: number[];

  if (opts.only?.length) {
    ids = opts.only;
  } else if (opts.query) {
    log.step(`Running saved query: ${opts.query}`);
    const result = await ado.runStoredQuery(opts.query);
    ids = result.ids;
    log.ok(`Query "${result.name}" (${result.path}, type ${result.queryType}) -> ${ids.length} work items`);
    if (result.parentByChild.size) {
      parentFromQuery = result.parentByChild;
      log.ok(`Tree query already provides ${result.parentByChild.size} parent-child relations`);
    }
    if (cfg.mapping.options.wiqlFilter) log.warn("--query is in use, so options.wiqlFilter is ignored.");
  } else {
    log.step("Querying the work item list (WIQL)");
    ids = await ado.listWorkItemIds({
      includeRemoved: cfg.mapping.options.includeRemovedWorkItems,
      extraFilter: cfg.mapping.options.wiqlFilter,
    });
  }

  if (opts.limit && ids.length > opts.limit) {
    log.warn(`Limited to ${opts.limit}/${ids.length} work items (--limit).`);
    ids = ids.slice(0, opts.limit);
  }
  log.ok(`${ids.length} work items to export`);

  // -- Work item details ---------------------------------------------------
  const typeCounts: Record<string, number> = {};
  const stateCounts: Record<string, number> = {};
  let attachmentCount = 0;
  let commentCount = 0;

  const todo: number[] = [];
  for (const id of ids) {
    if (opts.resume && await exists(layout.workItem(id))) {
      const cached = await layout.readWorkItem(id);
      if (cached) {
        tally(typeCounts, cached.workItem.fields["System.WorkItemType"]);
        tally(stateCounts, cached.workItem.fields["System.State"]);
        commentCount += cached.comments.length;
        attachmentCount += cached.attachments.filter((a) => !a.skipped).length;
        continue;
      }
    }
    todo.push(id);
  }
  if (opts.resume && todo.length < ids.length) {
    log.info(`Resume: skipping ${ids.length - todo.length} already exported work items.`);
  }

  log.step(`Exporting details for ${todo.length} work items`);
  const progress = new Progress("work items", todo.length);

  for (const batch of chunk(todo, 200)) {
    const items = await ado.getWorkItems(batch);
    const byId = new Map(items.map((i) => [i.id, i]));

    // A tree query already states the parent, so use it when System.Parent is
    // empty (happens for non-hierarchy links, or when the parent is out of scope).
    if (parentFromQuery) {
      for (const item of items) {
        const fromQuery = parentFromQuery.get(item.id);
        if (fromQuery !== undefined && item.fields["System.Parent"] === undefined) {
          item.fields["System.Parent"] = fromQuery;
        }
      }
    }

    await pool(batch, cfg.concurrency, async (id) => {
      const wi = byId.get(id);
      if (!wi) {
        log.warn(`Work item ${id} could not be read (deleted or no permission), skipping.`);
        progress.tick(false);
        return;
      }
      try {
        const exported = await exportOne(cfg, ado, layout, wi);
        tally(typeCounts, wi.fields["System.WorkItemType"]);
        tally(stateCounts, wi.fields["System.State"]);
        commentCount += exported.comments.length;
        attachmentCount += exported.attachments.filter((a) => !a.skipped).length;
        progress.tick(true);
      } catch (err) {
        log.error(`Work item ${id}: ${(err as Error).message}`);
        progress.tick(false);
      }
    });
  }
  progress.finish();

  const manifest: ExportManifest = {
    exportedAt: new Date().toISOString(),
    org: cfg.ado.org,
    project: cfg.ado.project,
    projectId: project.id,
    workItemCount: ids.length,
    workItemIds: ids,
    typeCounts,
    stateCounts,
    iterationCount: iterations.length,
    attachmentCount,
    commentCount,
  };
  await Deno.writeTextFile(layout.manifest, JSON.stringify(manifest, null, 2));

  log.header("Export xong");
  log.ok(`${ids.length} work items · ${commentCount} comments · ${attachmentCount} attachments`);
  log.info("Work item types:", typeCounts);
  log.info("States:", stateCounts);
  log.info(`Data written to ${cfg.dataDir}`);
  return manifest;
}

async function exportOne(
  cfg: Config,
  ado: AdoClient,
  layout: DataLayout,
  wi: AdoWorkItem,
): Promise<ExportedWorkItem> {
  const o = cfg.mapping.options;
  const comments = o.includeComments ? await ado.getComments(wi.id) : [];
  const updates = o.includeHistory ? await ado.getUpdates(wi.id) : [];

  const attachments: AttachmentManifestEntry[] = [];
  if (o.includeAttachments) {
    const wanted = collectAttachments(wi, comments.map((c) => c.text).join("\n"));
    if (wanted.length) await ensureDir(layout.attachmentDir(wi.id));
    for (const entry of wanted) {
      const target = join(layout.attachmentDir(wi.id), entry.storedName);
      const record: AttachmentManifestEntry = {
        workItemId: wi.id,
        guid: entry.guid,
        fileName: entry.fileName,
        file: target,
        size: entry.size ?? 0,
        comment: entry.comment,
        inline: entry.inline,
      };
      if (entry.size && entry.size > cfg.maxAttachmentBytes) {
        record.skipped = `Larger than ${(cfg.maxAttachmentBytes / 1024 / 1024).toFixed(0)}MB`;
        attachments.push(record);
        continue;
      }
      try {
        if (!(await exists(target))) {
          const bytes = await ado.downloadAttachment(entry.url);
          if (bytes.byteLength > cfg.maxAttachmentBytes) {
            record.skipped = `Larger than ${(cfg.maxAttachmentBytes / 1024 / 1024).toFixed(0)}MB`;
            record.size = bytes.byteLength;
            attachments.push(record);
            continue;
          }
          await Deno.writeFile(target, bytes);
          record.size = bytes.byteLength;
        } else {
          record.size = (await Deno.stat(target)).size;
        }
      } catch (err) {
        record.skipped = `Download failed: ${(err as Error).message.slice(0, 200)}`;
      }
      attachments.push(record);
    }
  }

  const payload: ExportedWorkItem = { workItem: wi, comments, updates, attachments };
  const file = layout.workItem(wi.id);
  await ensureDir(join(file, ".."));
  await Deno.writeTextFile(file, JSON.stringify(payload));
  return payload;
}

interface PendingAttachment {
  guid: string;
  fileName: string;
  storedName: string;
  url: string;
  size?: number;
  comment?: string;
  inline: boolean;
}

/**
 * Collect attachments from relations (`AttachedFile`) plus images embedded in
 * the HTML of description / acceptance criteria / repro steps / comments.
 */
function collectAttachments(wi: AdoWorkItem, commentHtml: string): PendingAttachment[] {
  const found = new Map<string, PendingAttachment>();

  for (const rel of wi.relations ?? []) {
    if (rel.rel !== "AttachedFile") continue;
    const guid = ATTACHMENT_GUID.exec(rel.url)?.[1];
    if (!guid) continue;
    const fileName = String(rel.attributes?.name ?? `${guid}.bin`);
    found.set(guid, {
      guid,
      fileName,
      storedName: safeName(guid, fileName),
      url: rel.url,
      size: typeof rel.attributes?.resourceSize === "number" ? rel.attributes.resourceSize : undefined,
      comment: rel.attributes?.comment ? String(rel.attributes.comment) : undefined,
      inline: false,
    });
  }

  const html = [
    wi.fields["System.Description"],
    wi.fields["Microsoft.VSTS.Common.AcceptanceCriteria"],
    wi.fields["Microsoft.VSTS.TCM.ReproSteps"],
    wi.fields["Microsoft.VSTS.TCM.SystemInfo"],
    commentHtml,
  ].filter(Boolean).join("\n");

  for (const match of html.matchAll(/src\s*=\s*["']([^"']*\/_apis\/wit\/attachments\/[^"']+)["']/gi)) {
    const rawUrl = decodeHtmlEntities(match[1]);
    const guid = ATTACHMENT_GUID.exec(rawUrl)?.[1];
    if (!guid || found.has(guid)) continue;
    let fileName = `${guid}.png`;
    try {
      fileName = new URL(rawUrl).searchParams.get("fileName") ?? fileName;
    } catch { /* relative URL, keep the default name */ }
    found.set(guid, {
      guid,
      fileName,
      storedName: safeName(guid, fileName),
      url: rawUrl.startsWith("http") ? rawUrl : `https:${rawUrl}`,
      inline: true,
    });
  }

  return [...found.values()];
}

function safeName(guid: string, fileName: string): string {
  // deno-lint-ignore no-control-regex -- control characters are stripped on purpose
  const clean = fileName.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(-120) || "file.bin";
  return `${guid.slice(0, 8)}-${clean}`;
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function tally(counter: Record<string, number>, key: unknown) {
  const k = String(key ?? "(unknown)");
  counter[k] = (counter[k] ?? 0) + 1;
}

function countNodes(node: { children?: unknown[] } | undefined): number {
  if (!node) return 0;
  const children = (node.children ?? []) as { children?: unknown[] }[];
  return 1 + children.reduce((sum, c) => sum + countNodes(c), 0);
}
