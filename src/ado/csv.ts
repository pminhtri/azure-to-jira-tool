import { join } from "node:path";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { ensureDir } from "../util/fsx.ts";
import { DataLayout } from "./export.ts";
import { normalizePath } from "./iterations.ts";
import type {
  AdoComment,
  AdoIdentity,
  AdoWorkItem,
  AdoWorkItemFields,
  ExportedWorkItem,
  ExportManifest,
  FlatIteration,
} from "./types.ts";

/* ── CSV parsing ─────────────────────────────────────────────────────────── */

/** RFC 4180 CSV parser: supports newlines inside fields and `""` escaping. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c !== '"') {
        field += c;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = false;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") { /* CRLF: ignore, wait for \n */ }
    else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

/* ── Column mapping ──────────────────────────────────────────────────────── */

/**
 * CSV column name -> ADO field name. Azure DevOps exports column headers in the
 * account's display language, so an explicit table beats guessing.
 */
const COLUMN_TO_FIELD: Record<string, string> = {
  "id": "System.Id",
  "work item type": "System.WorkItemType",
  "title": "System.Title",
  "assigned to": "System.AssignedTo",
  "state": "System.State",
  "reason": "System.Reason",
  "tags": "System.Tags",
  "area path": "System.AreaPath",
  "iteration path": "System.IterationPath",
  "description": "System.Description",
  "created date": "System.CreatedDate",
  "created by": "System.CreatedBy",
  "changed date": "System.ChangedDate",
  "changed by": "System.ChangedBy",
  "closed date": "Microsoft.VSTS.Common.ClosedDate",
  "closed by": "Microsoft.VSTS.Common.ClosedBy",
  "resolved date": "Microsoft.VSTS.Common.ResolvedDate",
  "activated date": "Microsoft.VSTS.Common.ActivatedDate",
  "activated by": "Microsoft.VSTS.Common.ActivatedBy",
  "priority": "Microsoft.VSTS.Common.Priority",
  "severity": "Microsoft.VSTS.Common.Severity",
  "stack rank": "Microsoft.VSTS.Common.StackRank",
  "backlog priority": "Microsoft.VSTS.Common.BacklogPriority",
  "value area": "Microsoft.VSTS.Common.ValueArea",
  "acceptance criteria": "Microsoft.VSTS.Common.AcceptanceCriteria",
  "story points": "Microsoft.VSTS.Scheduling.StoryPoints",
  "effort": "Microsoft.VSTS.Scheduling.Effort",
  "original estimate": "Microsoft.VSTS.Scheduling.OriginalEstimate",
  "remaining work": "Microsoft.VSTS.Scheduling.RemainingWork",
  "completed work": "Microsoft.VSTS.Scheduling.CompletedWork",
  "start date": "Microsoft.VSTS.Scheduling.StartDate",
  "target date": "Microsoft.VSTS.Scheduling.TargetDate",
  "due date": "Microsoft.VSTS.Scheduling.DueDate",
  "repro steps": "Microsoft.VSTS.TCM.ReproSteps",
  "system info": "Microsoft.VSTS.TCM.SystemInfo",
  "board column": "System.BoardColumn",
  "parent": "System.Parent",
};

const IDENTITY_FIELDS = new Set([
  "System.AssignedTo",
  "System.CreatedBy",
  "System.ChangedBy",
  "Microsoft.VSTS.Common.ClosedBy",
  "Microsoft.VSTS.Common.ActivatedBy",
]);

const DATE_FIELDS = new Set([
  "System.CreatedDate",
  "System.ChangedDate",
  "Microsoft.VSTS.Common.ClosedDate",
  "Microsoft.VSTS.Common.ResolvedDate",
  "Microsoft.VSTS.Common.ActivatedDate",
  "Microsoft.VSTS.Scheduling.StartDate",
  "Microsoft.VSTS.Scheduling.TargetDate",
  "Microsoft.VSTS.Scheduling.DueDate",
]);

const NUMBER_FIELDS = new Set([
  "System.Parent",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.Common.StackRank",
  "Microsoft.VSTS.Common.BacklogPriority",
  "Microsoft.VSTS.Scheduling.StoryPoints",
  "Microsoft.VSTS.Scheduling.Effort",
  "Microsoft.VSTS.Scheduling.OriginalEstimate",
  "Microsoft.VSTS.Scheduling.RemainingWork",
  "Microsoft.VSTS.Scheduling.CompletedWork",
]);

/** `Nguyen Van A <a@company.com>` -> the identity object the REST API returns. */
export function parseIdentity(value: string): AdoIdentity | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const m = /^(.*?)\s*<([^>]+)>$/.exec(trimmed);
  if (m) return { displayName: m[1].trim() || m[2], uniqueName: m[2].trim().toLowerCase() };
  return trimmed.includes("@")
    ? { displayName: trimmed, uniqueName: trimmed.toLowerCase() }
    : { displayName: trimmed };
}

export type DateOrder = "month-first" | "day-first";

/**
 * Infer day/month order from every date value in the file.
 * ADO exports in the account's locale, so `3/4/2026` may be 4 March or 3 April —
 * the two are only distinguishable once some value exceeds 12 in one position.
 */
export function detectDateOrder(samples: string[]): { order: DateOrder; confident: boolean } {
  let firstOver12 = false;
  let secondOver12 = false;
  for (const s of samples) {
    const m = /^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
    if (!m) continue;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  if (secondOver12 && !firstOver12) return { order: "month-first", confident: true };
  if (firstOver12 && !secondOver12) return { order: "day-first", confident: true };
  return { order: "month-first", confident: false };
}

/** `3/4/2026 6:55:03 PM` -> ISO 8601. Returns null when it cannot be parsed. */
export function parseCsvDate(value: string, order: DateOrder): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/.exec(
    trimmed,
  );
  if (!m) {
    const iso = new Date(trimmed);
    return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
  }

  const [, a, b, year, hourRaw, minute, second, meridiem] = m;
  const month = order === "month-first" ? Number(a) : Number(b);
  const day = order === "month-first" ? Number(b) : Number(a);

  let hour = hourRaw ? Number(hourRaw) : 0;
  if (meridiem) {
    const pm = meridiem.toLowerCase() === "pm";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // The CSV carries no timezone; treat it as UTC so every run is reproducible.
  const date = new Date(
    Date.UTC(Number(year), month - 1, day, hour, Number(minute ?? 0), Number(second ?? 0)),
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* -- Convert CSV into .data/ --------------------------------------------- */

export interface CsvImportOptions {
  /** One or more CSV files; work items merge by ID, later files win on conflict. */
  files: string[];
  /** Force the date order instead of inferring it. */
  dateOrder?: DateOrder;
  limit?: number;
}

export interface CsvImportResult {
  manifest: ExportManifest;
  warnings: string[];
}

/** One parsed file, kept so tree hierarchy can be derived per file. */
interface ParsedFile {
  path: string;
  body: string[][];
  idIndex: number;
  titleLevels: number[];
}

/**
 * Read an Azure DevOps CSV export and write the exact `.data/` layout the import
 * phase consumes, so the whole downstream pipeline (sprints, labels, rank,
 * transitions) behaves identically to the REST API source.
 *
 * Accepts several files because one ADO query usually covers only part of the
 * backlog; merging by ID stitches overlapping exports into a complete set.
 */
export async function runCsvImport(cfg: Config, opts: CsvImportOptions): Promise<CsvImportResult> {
  const layout = new DataLayout(cfg.dataDir);
  const warnings: string[] = [];
  if (!opts.files.length) throw new Error("At least one CSV file is required.");

  log.header("CSV Azure DevOps → local export");

  const merged = new Map<number, AdoWorkItem>();
  const comments = new Map<number, AdoComment[]>();
  const parsedFiles: ParsedFile[] = [];
  const unknownColumns = new Set<string>();
  const skippedRemoved = new Set<number>();
  const perFileNew: { path: string; total: number; added: number; overwritten: number }[] = [];
  /** Attachment count per work item, so repeats across files are not double counted. */
  const attachmentsLostById = new Map<number, number>();
  let badDates = 0;

  for (const path of opts.files) {
    const raw = await Deno.readTextFile(path).catch((err) => {
      if (err instanceof Deno.errors.NotFound) throw new Error(`CSV file not found: ${path}`);
      throw err;
    });

    const rows = parseCsv(raw);
    if (rows.length < 2) throw new Error(`CSV file is empty or header-only: ${path}`);

    const header = rows[0].map((h) => h.trim());
    const body = rows.slice(1);

    const idIndex = header.findIndex((h) => h.toLowerCase() === "id");
    if (idIndex === -1) {
      throw new Error(
        `${path} is missing the "ID" column. Columns present: ${header.join(", ")}\n` +
          `Re-export from Azure DevOps with the ID column included in the query.`,
      );
    }

    // Track unmapped columns so the user learns which data is being dropped.
    const known = new Map<number, string>();
    const titleLevels: number[] = [];
    let historyIndex = -1;
    let attachmentCountIndex = -1;

    header.forEach((name, index) => {
      const key = name.toLowerCase();
      if (key === "history") {
        historyIndex = index;
        return;
      }
      if (key === "attached file count") {
        attachmentCountIndex = index;
        return;
      }
      if (/^title \d+$/.test(key)) {
        titleLevels.push(index);
        return;
      }
      const field = COLUMN_TO_FIELD[key];
      if (field) known.set(index, field);
      else if (name) unknownColumns.add(name);
    });

    // Date order is inferred per file; exports may come from different locales.
    const dateSamples: string[] = [];
    for (const [index, field] of known) {
      if (!DATE_FIELDS.has(field)) continue;
      for (const row of body) if (row[index]) dateSamples.push(row[index]);
    }
    const detected = detectDateOrder(dateSamples);
    const order = opts.dateOrder ?? detected.order;
    if (opts.dateOrder) log.info(`${path}: date order ${order} (forced by --date-order)`);
    else if (detected.confident) log.ok(`${path}: date order ${order} (inferred from the data)`);
    else {
      warnings.push(
        `${path}: date order could not be determined with confidence (every day/month ` +
          `value is <= 12). Assuming ${order}. Verify and pass --date-order=day-first if wrong.`,
      );
    }

    let added = 0;
    let overwritten = 0;

    for (const row of body) {
      const id = Number(row[idIndex]);
      if (!Number.isFinite(id)) continue;

      const fields: AdoWorkItemFields = { "System.Id": id };
      for (const [index, field] of known) {
        const value = (row[index] ?? "").trim();
        if (!value) continue;

        if (IDENTITY_FIELDS.has(field)) {
          const identity = parseIdentity(value);
          if (identity) (fields as Record<string, unknown>)[field] = identity;
        } else if (DATE_FIELDS.has(field)) {
          const iso = parseCsvDate(value, order);
          if (iso) (fields as Record<string, unknown>)[field] = iso;
          else badDates++;
        } else if (NUMBER_FIELDS.has(field)) {
          const num = Number(value.replace(/,/g, ""));
          if (Number.isFinite(num)) (fields as Record<string, unknown>)[field] = num;
        } else if (field !== "System.Id") {
          (fields as Record<string, unknown>)[field] = value;
        }
      }

      if (!fields["System.WorkItemType"]) fields["System.WorkItemType"] = "Task";
      if (!fields["System.Title"]) fields["System.Title"] = `Work item ${id}`;
      if (!fields["System.State"]) fields["System.State"] = "New";

      if (fields["System.State"] === "Removed" && !cfg.mapping.options.includeRemovedWorkItems) {
        skippedRemoved.add(id);
        merged.delete(id);
        continue;
      }

      const attachmentCount = attachmentCountIndex >= 0 ? Number(row[attachmentCountIndex]) : 0;
      if (Number.isFinite(attachmentCount) && attachmentCount > 0) {
        attachmentsLostById.set(id, attachmentCount);
      } else attachmentsLostById.delete(id);

      if (merged.has(id)) overwritten++;
      else added++;

      merged.set(id, {
        id,
        rev: 1,
        url: `${cfg.ado.baseUrl}/_apis/wit/workItems/${id}`,
        fields,
      });

      // The CSV History column holds only the last entry, not the full discussion.
      const history = historyIndex >= 0 ? (row[historyIndex] ?? "").trim() : "";
      if (history) {
        comments.set(id, [{
          id: 1,
          workItemId: id,
          version: 1,
          text: history,
          createdBy: fields["System.ChangedBy"],
          createdDate: fields["System.ChangedDate"],
        }]);
      } else comments.delete(id);
    }

    perFileNew.push({ path, total: body.length, added, overwritten });
    parsedFiles.push({ path, body, idIndex, titleLevels });
    log.ok(`${path}: ${body.length} rows -> ${added} new work items, ${overwritten} overwritten`);
  }

  if (opts.files.length > 1) {
    log.ok(`Merged ${opts.files.length} files -> ${merged.size} unique work items`);
    for (const f of perFileNew) {
      if (!f.added && f.overwritten) {
        warnings.push(
          `${f.path} contributed no new work items; all of them already came from an earlier file.`,
        );
      }
    }
  }

  let items = [...merged.values()].sort((a, b) => a.id - b.id);
  if (opts.limit && items.length > opts.limit) {
    log.warn(`Limited to ${opts.limit}/${items.length} work items (--limit).`);
    items = items.slice(0, opts.limit);
  }

  /* ── Hierarchy ───────────────────────────────────────────────────────── */

  const byId = new Map(items.map((i) => [i.id, i]));
  let parentsFromColumn = 0;
  for (const item of items) {
    const parent = item.fields["System.Parent"];
    if (typeof parent === "number" && byId.has(parent)) parentsFromColumn++;
    else if (parent !== undefined) delete item.fields["System.Parent"];
  }

  let parentsFromTree = 0;
  if (!parentsFromColumn) {
    // Tree structure lives in row order, so it must be derived file by file.
    for (const f of parsedFiles) {
      if (f.titleLevels.length > 1) {
        parentsFromTree += applyTreeHierarchy(f.body, f.idIndex, f.titleLevels, byId);
      }
    }
  }

  const totalParents = parentsFromColumn + parentsFromTree;
  if (totalParents) {
    log.ok(
      `Hierarchy: ${totalParents} parent-child relations ` +
        `(source: ${parentsFromColumn ? "Parent column" : "Title 1/2/3 columns"})`,
    );
  } else {
    const counts: Record<string, number> = {};
    for (const i of items) {
      counts[String(i.fields["System.WorkItemType"])] =
        (counts[String(i.fields["System.WorkItemType"])] ?? 0) + 1;
    }
    warnings.push(
      `The CSV has no "Parent" or "Title 1/2/3" column, so parent-child relations ` +
        `CANNOT be migrated.\n` +
        `  Present data: ${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ")} — ` +
        `these will become flat issues in Jira.\n` +
        `  Fix: re-export from Azure DevOps with the "Parent" column in the query ` +
        `(Queries -> Column Options -> add Parent), then run this command again.`,
    );
  }

  /* ── Iterations ──────────────────────────────────────────────────────── */

  const iterationPaths = new Set<string>();
  for (const item of items) {
    const path = item.fields["System.IterationPath"];
    if (path) iterationPaths.add(normalizePath(path));
  }

  const projectName = items[0]?.fields["System.AreaPath"]?.split("\\")[0] ?? cfg.ado.project;
  const sprintDates = cfg.mapping.sprintDates ?? {};
  const iterations: FlatIteration[] = [];

  for (const path of [...iterationPaths].sort()) {
    const segments = path.split("\\");
    // The root iteration (same name as the project) is the backlog, not a sprint.
    if (segments.length <= 1) continue;
    const dates = sprintDates[path] ?? sprintDates[segments.slice(1).join("\\")];
    const start = dates?.start ? new Date(dates.start).toISOString() : null;
    const finish = dates?.end ? new Date(dates.end).toISOString() : null;
    iterations.push({
      path,
      name: segments[segments.length - 1],
      startDate: start,
      finishDate: finish,
      timeFrame: finish && Date.parse(finish) < Date.now() ? "past" : start ? "current" : "future",
      depth: segments.length - 1,
      isLeaf: true,
    });
  }

  const rootCount = items.filter((i) => {
    const p = i.fields["System.IterationPath"];
    return !p || normalizePath(p).split("\\").length <= 1;
  }).length;

  if (iterations.length && !Object.keys(sprintDates).length) {
    warnings.push(
      `The CSV carries no iteration start/finish dates, so ${iterations.length} sprints ` +
        `will be created without dates and cannot be closed automatically.\n` +
        `  Fix: fill in "sprintDates" in migration.config.json, for example:\n` +
        `  "sprintDates": { ${
          iterations.map((i) =>
            `"${i.path.replace(/\\/g, "\\\\")}": { "start": "2026-01-01", "end": "2026-01-14" }`
          )
            .slice(0, 2).join(", ")
        } }`,
    );
  }

  /* -- Write to disk ---------------------------------------------------- */

  await ensureDir(cfg.dataDir);
  await Deno.writeTextFile(
    layout.project,
    JSON.stringify({ id: "csv-import", name: projectName, sources: opts.files }, null, 2),
  );
  await Deno.writeTextFile(layout.iterations, JSON.stringify(iterations, null, 2));
  await Deno.writeTextFile(
    layout.iterationTree,
    JSON.stringify({ source: "csv", paths: [...iterationPaths] }, null, 2),
  );
  await Deno.writeTextFile(layout.areaTree, JSON.stringify({ source: "csv" }, null, 2));
  await Deno.writeTextFile(layout.teams, JSON.stringify([], null, 2));

  const typeCounts: Record<string, number> = {};
  const stateCounts: Record<string, number> = {};

  for (const item of items) {
    const payload: ExportedWorkItem = {
      workItem: item,
      comments: comments.get(item.id) ?? [],
      updates: [],
      attachments: [],
    };
    const file = layout.workItem(item.id);
    await ensureDir(join(file, ".."));
    await Deno.writeTextFile(file, JSON.stringify(payload));

    const type = String(item.fields["System.WorkItemType"]);
    const state = String(item.fields["System.State"]);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
  }

  const manifest: ExportManifest = {
    exportedAt: new Date().toISOString(),
    org: cfg.ado.org,
    project: projectName,
    projectId: "csv-import",
    workItemCount: items.length,
    workItemIds: items.map((i) => i.id).sort((a, b) => a - b),
    typeCounts,
    stateCounts,
    iterationCount: iterations.length,
    attachmentCount: 0,
    commentCount: [...comments.values()].reduce((n, c) => n + c.length, 0),
  };
  await Deno.writeTextFile(layout.manifest, JSON.stringify(manifest, null, 2));

  /* -- Report ------------------------------------------------------------ */

  if (unknownColumns.size) {
    warnings.push(`Unrecognised columns (ignored): ${[...unknownColumns].join(", ")}`);
  }
  // Count only work items that survived the Removed filter and --limit.
  const keptIds = new Set(items.map((i) => i.id));
  let attachmentsLost = 0;
  for (const [id, n] of attachmentsLostById) if (keptIds.has(id)) attachmentsLost += n;
  if (attachmentsLost) {
    warnings.push(
      `${attachmentsLost} attachments are not in the CSV — files can only be downloaded ` +
        `through the REST API. Use \`deno task export\` if you need them.`,
    );
  }
  if (badDates) warnings.push(`${badDates} date values could not be parsed and were dropped.`);
  if (skippedRemoved.size) {
    log.info(
      `Skipped ${skippedRemoved.size} work items in state "Removed" ` +
        `(set options.includeRemovedWorkItems = true to keep them).`,
    );
  }
  if (manifest.commentCount) {
    warnings.push(
      `The CSV History column holds only the last change note, not the full discussion. ` +
        `${manifest.commentCount} notes became comments; real comments require the REST API.`,
    );
  }

  log.header("CSV conversion complete");
  log.ok(`${items.length} work items · ${iterations.length} sprints · ${manifest.commentCount} notes`);
  log.info("Work item types:", typeCounts);
  log.info("States:", stateCounts);
  if (rootCount) log.info(`${rootCount} work items sit in the root backlog (no sprint)`);

  for (const w of warnings) log.warn(w);
  log.info(`Data written to ${cfg.dataDir} — run \`deno task plan\` to preview the mapping.`);

  return { manifest, warnings };
}

/**
 * Derive hierarchy from an ADO tree export (`Title 1`, `Title 2`, … columns).
 * Each row fills only the Title cell at its own level, so the level identifies
 * the parent.
 */
function applyTreeHierarchy(
  body: string[][],
  idIndex: number,
  titleLevels: number[],
  byId: Map<number, AdoWorkItem>,
): number {
  const stack: (number | undefined)[] = [];
  let linked = 0;

  for (const row of body) {
    const id = Number(row[idIndex]);
    if (!Number.isFinite(id)) continue;

    const level = titleLevels.findIndex((index) => (row[index] ?? "").trim() !== "");
    if (level === -1) continue;

    stack.length = level;
    // A tree can skip levels (Title 3 directly under Title 1), so walk back to
    // the nearest defined ancestor instead of treating the row as a root.
    let parentId: number | undefined;
    for (let l = level - 1; l >= 0; l--) {
      if (stack[l] !== undefined) {
        parentId = stack[l];
        break;
      }
    }
    stack[level] = id;

    const item = byId.get(id);
    if (!item) continue;
    if (parentId !== undefined && byId.has(parentId)) {
      item.fields["System.Parent"] = parentId;
      linked++;
    }
  }
  return linked;
}
