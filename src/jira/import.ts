import type { Config } from "../config.ts";
import { log, Progress } from "../log.ts";
import { pool } from "../util/pool.ts";
import { HttpError } from "../util/http.ts";
import type { Store } from "../util/state.ts";
import { DataLayout } from "../ado/export.ts";
import { normalizePath } from "../ado/iterations.ts";
import type { AdoIdentity, ExportedWorkItem, ExportManifest, FlatIteration } from "../ado/types.ts";
import { type JiraBoard, JiraClient, type JiraField } from "./client.ts";
import type { ImageResolution } from "./adf.ts";
import {
  buildCommentBody,
  buildDescription,
  buildHistoryComment,
  buildIssueDraft,
  type IssueDraft,
  type TransformContext,
} from "./transform.ts";

export const PHASES = [
  "preflight",
  "users",
  "sprints",
  "issues",
  "hierarchy",
  "links",
  "attachments",
  "comments",
  "sprint-assign",
  "rank",
  "transitions",
] as const;
export type Phase = (typeof PHASES)[number];

export interface ImportOptions {
  dryRun: boolean;
  phases: Phase[];
  only?: number[];
  limit?: number;
}

interface LoadedItem {
  data: ExportedWorkItem;
  draft: IssueDraft;
}

/** Orchestrates every write to Jira, one resumable phase at a time. */
export class Importer {
  private jira: JiraClient;
  private layout: DataLayout;
  private ctx!: TransformContext;
  private fieldsByType = new Map<string, Set<string>>();
  private knownComponents = new Set<string>();
  private knownStatuses = new Set<string>();
  private knownLinkTypes = new Set<string>();
  private issueTypeByName = new Map<string, { id: string; hierarchyLevel: number; subtask: boolean }>();
  private board: JiraBoard | null = null;
  private manifest!: ExportManifest;
  private raw = new Map<number, ExportedWorkItem>();
  private items = new Map<number, LoadedItem>();
  private order: number[] = [];

  constructor(private cfg: Config, private store: Store, private opts: ImportOptions) {
    this.jira = new JiraClient(cfg);
    this.layout = new DataLayout(cfg.dataDir);
  }

  private want(phase: Phase) {
    return this.opts.phases.includes(phase);
  }

  async run(): Promise<void> {
    await this.preflight();
    if (this.want("users")) await this.phaseUsers();
    // Always build drafts after the users phase so assignees have an accountId.
    this.buildDrafts();
    if (this.want("sprints")) await this.phaseSprints();
    if (this.want("issues")) await this.phaseIssues();
    if (this.want("hierarchy")) await this.phaseHierarchy();
    if (this.want("links")) await this.phaseLinks();
    if (this.want("attachments")) await this.phaseAttachments();
    if (this.want("comments")) await this.phaseComments();
    if (this.want("sprint-assign")) await this.phaseSprintAssign();
    if (this.want("rank")) await this.phaseRank();
    if (this.want("transitions")) await this.phaseTransitions();
    await this.summary();
  }

  /* ── 1. Preflight ─────────────────────────────────────────────────────── */

  private async preflight(): Promise<void> {
    log.header("Preflight");
    this.manifest = await this.layout.readManifest();
    log.ok(
      `Read export: ${this.manifest.workItemCount} work items from ${this.manifest.org}/${this.manifest.project}`,
    );

    if (this.cfg.jira.deployment === "auto") {
      const { deployment, info, confirmed } = await this.jira.detectDeployment();
      const line = `Jira: ${deployment === "server" ? "Server / Data Center" : "Cloud"} edition` +
        `${info.version ? ` v${info.version}` : ""} — using API ` +
        `${deployment === "server" ? "v2 + wiki markup" : "v3 + ADF"}`;
      // Only claim detection when /serverInfo actually said so.
      if (confirmed) log.ok(line);
      else log.warn(`${line} (guessed from the hostname; /serverInfo did not answer with JSON)`);
    } else {
      this.jira.setDeployment(this.cfg.jira.deployment);
      log.ok(`Jira: ${this.cfg.jira.deployment} edition (forced by JIRA_DEPLOYMENT)`);
    }

    const me = await this.jira.myself();
    log.ok(`Jira: signed in as ${me.displayName} <${me.emailAddress ?? "?"}>`);

    const project = await this.jira.getProject();
    log.ok(`Target project: ${project.key} — ${project.name} (${project.style ?? "classic"})`);

    for (const it of project.issueTypes ?? []) {
      this.issueTypeByName.set(it.name.toLowerCase(), {
        id: it.id,
        hierarchyLevel: it.hierarchyLevel ?? (it.subtask ? -1 : 0),
        subtask: it.subtask,
      });
    }

    // Every issue type in the mapping must exist on the project.
    const missingTypes = new Set<string>();
    for (const [adoType, jiraType] of Object.entries(this.cfg.mapping.issueType)) {
      if (adoType.startsWith("_")) continue;
      if (!this.issueTypeByName.has(jiraType.toLowerCase())) missingTypes.add(`${adoType} → ${jiraType}`);
    }
    const fallback = this.cfg.mapping.issueType._default;
    if (fallback && !this.issueTypeByName.has(fallback.toLowerCase())) {
      missingTypes.add(`_default → ${fallback}`);
    }
    if (missingTypes.size) {
      throw new Error(
        `These issue types do not exist in project ${project.key}:\n  ` +
          [...missingTypes].join("\n  ") +
          `\nAvailable issue types: ${[...this.issueTypeByName.keys()].join(", ")}\n` +
          `Fix the "issueType" section in migration.config.json.`,
      );
    }

    // Available fields for each issue type actually used.
    const usedTypes = new Set(Object.values(this.cfg.mapping.issueType));
    for (const name of usedTypes) {
      const meta = this.issueTypeByName.get(name.toLowerCase());
      if (!meta) continue;
      try {
        this.fieldsByType.set(name.toLowerCase(), await this.jira.getCreateMetaFields(meta.id));
      } catch (err) {
        log.warn(
          `Could not read createmeta for "${name}" (${(err as Error).message.slice(0, 120)}). ` +
            `Falling back to sending every field and relying on the error response.`,
        );
      }
    }

    for (const c of await this.jira.getComponents()) this.knownComponents.add(c.name);
    for (const s of await this.jira.getStatuses()) this.knownStatuses.add(s.name.toLowerCase());
    for (const t of await this.jira.getIssueLinkTypes()) this.knownLinkTypes.add(t.name.toLowerCase());

    this.warnUnknownStatuses();
    await this.validateCustomFields();

    if (this.cfg.mapping.options.includeSprints && (this.want("sprints") || this.want("sprint-assign"))) {
      await this.resolveBoard();
    }

    this.ctx = {
      cfg: this.cfg,
      adoWebUrl: (id) =>
        `${this.cfg.ado.baseUrl}/${encodeURIComponent(this.cfg.ado.project)}/_workitems/edit/${id}`,
      resolveUser: (identity) => this.lookupUserCached(identity),
      allowedFields: (typeName) => this.fieldsByType.get(typeName.toLowerCase()) ?? null,
      knownComponents: this.knownComponents,
      assigneeRef: (accountId) => this.jira.assigneeRef(accountId),
      unassignedRef: () => this.jira.unassignedRef(),
      resolveImage: (guid, fileName) => this.resolveImage(guid, fileName),
    };

    await this.loadRawItems();
  }

  private warnUnknownStatuses() {
    const unknown = new Set<string>();
    for (const [adoState, jiraStatus] of Object.entries(this.cfg.mapping.status)) {
      if (adoState.startsWith("_")) continue;
      if (!this.knownStatuses.has(jiraStatus.toLowerCase())) unknown.add(`${adoState} → ${jiraStatus}`);
    }
    if (unknown.size) {
      log.warn(
        `Statuses missing from the project workflow (those issues keep their default status):\n  ${
          [...unknown].join("\n  ")
        }`,
      );
    }
    const unknownLinks = new Set<string>();
    for (const map of Object.values(this.cfg.mapping.linkType)) {
      if (!this.knownLinkTypes.has(map.name.toLowerCase())) unknownLinks.add(map.name);
    }
    if (unknownLinks.size) {
      log.warn(
        `Issue link types that do not exist: ${[...unknownLinks].join(", ")}. ` +
          `Those links will be skipped. Available types: ${[...this.knownLinkTypes].join(", ")}`,
      );
    }
  }

  private async validateCustomFields() {
    const configured = Object.entries(this.cfg.mapping.fields).filter(([, v]) => v);
    if (!configured.length) return;
    const all = await this.jira.getFields();
    const byId = new Map<string, JiraField>(all.map((f) => [f.id, f]));
    for (const [key, id] of configured) {
      const field = byId.get(id as string);
      if (!field) log.warn(`fields.${key} = "${id}" does not exist on this Jira site -> it will be skipped.`);
      else log.debug(`fields.${key} = ${id} ("${field.name}")`);
    }
  }

  private async resolveBoard() {
    if (!(await this.jira.probeAgile())) {
      log.warn(
        "Agile API is unreachable (not a Jira Software project, or missing permissions). Skipping sprints.",
      );
      return;
    }
    const boards = await this.jira.getBoards();
    const usable = boards.filter((b) => BOARDS_WITH_SPRINTS.has(b.type));

    if (!usable.length) {
      const kanban = boards.filter((b) => b.type === "kanban");
      log.warn(
        `Project ${this.cfg.jira.projectKey} has no board that supports sprints (found: ` +
          `${boards.map((b) => `"${b.name}" [${b.type}]`).join(", ") || "no boards at all"}).` +
          (kanban.length
            ? `\n  Kanban boards have no sprints. Use a Scrum board, or enable the Sprints feature ` +
              `if the project is team-managed (Project settings -> Features -> Sprints).`
            : `\n  Create a Scrum board, then re-run: deno task import --phase=sprints,sprint-assign`),
      );
      return;
    }

    const wanted = this.cfg.jira.boardName;
    this.board = wanted
      ? usable.find((b) => b.name.toLowerCase() === wanted.toLowerCase()) ?? null
      : usable[0];
    if (!this.board) {
      log.warn(
        `No board named "${wanted}". Boards that support sprints: ` +
          `${usable.map((b) => `"${b.name}" [${b.type}]`).join(", ")}`,
      );
      return;
    }
    if (this.board.type === "simple") {
      log.info(
        `Board "${this.board.name}" belongs to a team-managed project. Sprints work only if ` +
          `Project settings -> Features has Sprints enabled.`,
      );
    }
    this.store.data.boardId = this.board.id;
    this.store.touch();
    log.ok(`Board sprint: "${this.board.name}" (id ${this.board.id})`);
  }

  /** Load every exported work item into memory. */
  private async loadRawItems() {
    let ids = this.opts.only?.length
      ? this.manifest.workItemIds.filter((id) => this.opts.only!.includes(id))
      : this.manifest.workItemIds;
    if (this.opts.limit) ids = ids.slice(0, this.opts.limit);

    for (const id of ids) {
      const data = await this.layout.readWorkItem(id);
      if (!data) {
        log.warn(`No export file for work item ${id}, skipping.`);
        continue;
      }
      this.raw.set(id, data);
    }
    log.ok(`Loaded ${this.raw.size} work items to import`);
  }

  /**
   * Build the Jira payload for each work item.
   *
   * Must run AFTER the users phase: a draft embeds the assignee's accountId, so
   * building it before user lookup completes creates every issue unassigned.
   */
  private buildDrafts() {
    for (const [id, data] of this.raw) {
      this.items.set(id, { data, draft: buildIssueDraft(data.workItem, data.attachments, this.ctx) });
    }
    // Parents before children, so hierarchy still works on a partial run.
    this.order = topoSortByParent(this.items);
  }

  /* ── 2. Users ─────────────────────────────────────────────────────────── */

  private async phaseUsers() {
    log.header("Phase: users");
    const identities = new Map<string, AdoIdentity>();
    for (const data of this.raw.values()) {
      const f = data.workItem.fields;
      for (const id of [f["System.AssignedTo"], f["System.CreatedBy"], f["System.ChangedBy"]]) {
        const key = identityKey(id);
        if (key && !identities.has(key)) identities.set(key, id!);
      }
    }

    const manual = this.cfg.mapping.users.map;
    let resolved = 0;
    let missing = 0;

    for (const [key, identity] of identities) {
      if (this.store.data.users[key] !== undefined) {
        if (this.store.data.users[key]) resolved++;
        else missing++;
        continue;
      }
      const override = manual[key] ?? manual[identity.displayName ?? ""];
      if (override) {
        // Accept either a raw accountId or an email address in the config.
        const accountId = override.includes("@")
          ? (await this.jira.findUserByEmail(override))?.accountId ?? ""
          : override;
        this.store.data.users[key] = accountId;
        accountId ? resolved++ : missing++;
        continue;
      }
      if (!this.cfg.mapping.users.autoLookup || !key.includes("@")) {
        this.store.data.users[key] = "";
        missing++;
        continue;
      }
      const user = await this.jira.findUserByEmail(key);
      this.store.data.users[key] = user?.accountId ?? "";
      user ? resolved++ : missing++;
    }
    this.store.touch();
    await this.store.flush();

    log.ok(`User map: ${resolved} matched, ${missing} unmatched out of ${identities.size}`);
    if (missing) {
      const unmapped = Object.entries(this.store.data.users).filter(([, v]) => !v).map(([k]) => k);
      log.warn(
        `Could not map ${missing} users (those issues stay unassigned). Add them manually to "users.map" ` +
          `trong migration.config.json:\n  ${unmapped.slice(0, 20).join("\n  ")}` +
          (unmapped.length > 20 ? `\n  … and ${unmapped.length - 20} more` : ""),
      );
    }
  }

  /**
   * Jira only allows nesting when the parent type sits above the child type
   * (Epic=1 > Story/Task/Bug=0 > Sub-task=-1). Levels come from the project's own
   * metadata, so custom Advanced Roadmaps levels are honoured too.
   */
  private canNest(parentType: string, childType: string): boolean {
    // On Server/DC the `parent` field is ONLY for sub-tasks; the link to an Epic
    // must go through the Epic Link custom field.
    if (this.jira.flavor === "server") {
      const child = this.issueTypeByName.get(childType.toLowerCase());
      return child?.subtask === true;
    }
    const parent = this.issueTypeByName.get(parentType.toLowerCase());
    const child = this.issueTypeByName.get(childType.toLowerCase());
    // With no metadata, just try it and let Jira decide.
    if (!parent || !child) return true;
    return parent.hierarchyLevel > child.hierarchyLevel;
  }

  /** The most viable way to link this parent/child type pair. */
  private nestingStrategy(parentType: string, childType: string): NestingStrategy {
    if (this.canNest(parentType, childType)) return "parent";
    const epicField = this.cfg.mapping.fields.epicLink;
    if (
      epicField && parentType.toLowerCase() === "epic" &&
      this.issueTypeByName.get(childType.toLowerCase())?.subtask !== true
    ) return "epicLink";
    return "relates";
  }

  private lookupUserCached(identity: AdoIdentity | undefined): string | null {
    const key = identityKey(identity);
    if (!key) return null;
    return this.store.data.users[key] || null;
  }

  /* ── 3. Sprints ───────────────────────────────────────────────────────── */

  private async phaseSprints() {
    if (!this.cfg.mapping.options.includeSprints) return;
    log.header("Phase: sprints");
    if (!this.board) {
      log.warn("No usable board -> skipping sprint creation.");
      return;
    }

    const iterations = await this.layout.readIterations();
    // Only create sprints for iterations that work items actually use.
    const used = new Set<string>();
    for (const { draft } of this.items.values()) {
      if (draft.iterationPath) used.add(normalizePath(draft.iterationPath));
    }
    const targets = iterations.filter((i) => used.has(i.path));
    if (!targets.length) {
      log.info("No work item references an iteration -> no sprints needed.");
      return;
    }

    const existing = new Map(
      (await this.jira.getSprints(this.board.id)).map((s) => [s.name.toLowerCase(), s]),
    );

    const progress = new Progress("sprints", targets.length);
    // Create in chronological order so the backlog reads naturally.
    targets.sort((a, b) =>
      (a.startDate ?? "9999").localeCompare(b.startDate ?? "9999") || a.path.localeCompare(b.path)
    );

    for (const iteration of targets) {
      const name = sprintName(iteration);
      try {
        if (this.store.data.sprints[iteration.path]) {
          progress.tick(true);
          continue;
        }
        const found = existing.get(name.toLowerCase());
        if (found) {
          this.store.data.sprints[iteration.path] = found.id;
          this.store.touch();
          log.skip(`Sprint "${name}" already exists (id ${found.id})`);
          progress.tick(true);
          continue;
        }
        if (this.opts.dryRun) {
          log.info(
            `[dry-run] create sprint "${name}" (${iteration.startDate ?? "?"} -> ${
              iteration.finishDate ?? "?"
            })`,
          );
          progress.tick(true);
          continue;
        }
        const created = await this.jira.createSprint({
          name,
          originBoardId: this.board.id,
          // Jira requires both dates or neither.
          ...(iteration.startDate && iteration.finishDate
            ? { startDate: iteration.startDate, endDate: iteration.finishDate }
            : {}),
        });
        this.store.data.sprints[iteration.path] = created.id;
        this.store.touch();
        progress.tick(true);
      } catch (err) {
        this.store.fail("sprints", iteration.path, describe(err));
        log.error(`Sprint "${name}": ${describe(err)}`);
        progress.tick(false);
      }
    }
    progress.finish();
    await this.store.flush();
    log.ok(`${Object.keys(this.store.data.sprints).length} sprints ready`);
  }

  /* ── 4. Issues ────────────────────────────────────────────────────────── */

  private async phaseIssues() {
    log.header("Phase: issues");
    const todo = this.order.filter((id) => !this.store.issue(id));
    log.info(
      `${todo.length} issues to create (${
        this.order.length - todo.length
      } already exist from a previous run)`,
    );
    if (!todo.length) return;

    if (this.opts.dryRun) {
      for (const id of todo.slice(0, 5)) {
        const item = this.items.get(id)!;
        log.info(`[dry-run] ${id} → ${item.draft.issueTypeName}: ${item.draft.fields.summary}`);
        log.debug(JSON.stringify(item.draft.fields, null, 2));
      }
      log.info(`[dry-run] ${todo.length} issues would be created in total.`);
      return;
    }

    const progress = new Progress("issues", todo.length);
    await pool(todo, this.cfg.concurrency, async (adoId) => {
      const item = this.items.get(adoId)!;
      try {
        const created = await this.createWithRetry(item);
        this.store.setIssue(adoId, {
          key: created.key,
          id: created.id,
          issueType: item.draft.issueTypeName,
        });
        progress.tick(true);
      } catch (err) {
        this.store.fail("issues", String(adoId), describe(err));
        log.error(`Failed to create an issue for ADO #${adoId}: ${describe(err)}`);
        progress.tick(false);
      }
    });
    progress.finish();
    await this.store.flush();
  }

  /**
   * Create the issue; if Jira rejects a specific field, drop it and retry.
   * Keeps one misconfigured screen from breaking the whole migration.
   */
  private async createWithRetry(item: LoadedItem) {
    const fields = { ...item.draft.fields };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.jira.createIssue(fields);
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 400) throw err;
        const offending = extractFieldErrors(err.body).filter((f) => !PROTECTED_FIELDS.has(f));
        if (!offending.length) throw err;
        for (const f of offending) delete fields[f];
        log.warn(
          `ADO #${item.draft.adoId}: dropping field ${offending.join(", ")} and retrying (${err.detail})`,
        );
      }
    }
    return await this.jira.createIssue(fields);
  }

  /* ── 5. Hierarchy ─────────────────────────────────────────────────────── */

  private async phaseHierarchy() {
    log.header("Phase: hierarchy (parent / epic link)");
    const todo = this.order.filter((id) => {
      const rec = this.store.issue(id);
      const draft = this.items.get(id)?.draft;
      return rec && !rec.parentDone && draft?.parentAdoId;
    });
    if (!todo.length) {
      log.info("No parent-child relations to set.");
      return;
    }

    // Decide the linking strategy up front so we can summarise it and never send
    // a request Jira is certain to reject.
    const planned = todo.map((adoId) => {
      const draft = this.items.get(adoId)!.draft;
      const parent = this.store.issue(draft.parentAdoId!);
      return {
        adoId,
        draft,
        parent,
        how: parent ? this.nestingStrategy(parent.issueType, draft.issueTypeName) : "none",
      };
    });

    const counts: Record<string, number> = {};
    for (const p of planned) counts[p.how] = (counts[p.how] ?? 0) + 1;
    log.info(
      `Linking: ${Object.entries(counts).map(([k, v]) => `${v} via ${STRATEGY_LABEL[k] ?? k}`).join(" · ")}`,
    );
    if (counts.relates) {
      log.warn(
        `${counts.relates}/${todo.length} relations cannot nest in the Jira hierarchy ` +
          `-> keeping them as "Relates" links.`,
      );
    }
    if (this.jira.flavor === "server" && !this.cfg.mapping.fields.epicLink && counts.relates) {
      log.warn(
        `Jira Server links issues to an Epic through the Epic Link custom field, not "parent". ` +
          `Set fields.epicLink in migration.config.json (run \`deno task fields\` to get the id) ` +
          `to keep a real tree instead of flat links.`,
      );
    }

    const progress = new Progress("parents", todo.length);
    let demoted = 0;

    for (const { adoId, draft, parent, how } of planned) {
      const child = this.store.issue(adoId)!;
      if (!parent) {
        log.skip(`ADO #${adoId}: no issue created yet for parent #${draft.parentAdoId}`);
        progress.tick(false);
        continue;
      }
      if (this.opts.dryRun) {
        log.debug(`[dry-run] ${child.key} → ${parent.key} qua ${STRATEGY_LABEL[how]}`);
        progress.tick(true);
        continue;
      }

      const attempts: (() => Promise<void>)[] = [];
      if (how === "parent") {
        attempts.push(() => this.jira.updateIssue(child.key, { parent: { key: parent.key } }));
      }
      if (how === "epicLink" || how === "parent") {
        const epicField = this.cfg.mapping.fields.epicLink;
        if (epicField && parent.issueType.toLowerCase() === "epic") {
          attempts.push(() => this.jira.updateIssue(child.key, { [epicField]: parent.key }));
        }
      }
      const canRelate = this.knownLinkTypes.has("relates");
      if (canRelate) {
        attempts.push(async () => {
          await this.jira.createIssueLink("Relates", child.key, parent.key);
          demoted++;
        });
      }

      let lastError: unknown = null;
      let done = false;
      for (const attempt of attempts) {
        try {
          await attempt();
          done = true;
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (done) {
        this.store.patchIssue(adoId, { parentDone: true });
        progress.tick(true);
      } else {
        this.store.fail(
          "hierarchy",
          `${child.key}←${parent.key}`,
          lastError
            ? describe(lastError)
            : `${parent.issueType} cannot be the parent of ${draft.issueTypeName}, ` +
              `and the "Relates" link type is unavailable on this project.`,
        );
        progress.tick(false);
      }
    }
    progress.finish();
    if (demoted) log.warn(`${demoted} relations were downgraded to "Relates" links.`);
    await this.store.flush();
  }

  /* ── 6. Links ─────────────────────────────────────────────────────────── */

  private async phaseLinks() {
    if (!this.cfg.mapping.options.includeLinks) return;
    log.header("Phase: links");

    interface PendingLink {
      adoId: number;
      inward: string;
      outward: string;
      type: string;
    }
    const pending: PendingLink[] = [];
    const seen = new Set<string>();

    for (const [adoId, item] of this.items) {
      const rec = this.store.issue(adoId);
      if (!rec || rec.linksDone) continue;
      for (const rel of item.data.workItem.relations ?? []) {
        const map = this.cfg.mapping.linkType[rel.rel];
        if (!map || !this.knownLinkTypes.has(map.name.toLowerCase())) continue;
        const targetId = Number(/\/workItems\/(\d+)/i.exec(rel.url)?.[1]);
        if (!Number.isFinite(targetId)) continue;
        const target = this.store.issue(targetId);
        if (!target) continue;

        const [inward, outward] = map.direction === "outward" ? [target.key, rec.key] : [rec.key, target.key];
        // ADO records one relation on both work items. For directed links
        // (Blocks) both sides yield the same (inward, outward) pair; for symmetric
        // links (Relates) they are reversed, so dedupe on an unordered pair.
        const dedupe = `${map.name}|${[inward, outward].sort().join("|")}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        pending.push({ adoId, inward, outward, type: map.name });
      }
    }

    if (!pending.length) {
      log.info("No links to create.");
      for (const adoId of this.items.keys()) this.store.patchIssue(adoId, { linksDone: true });
      return;
    }
    if (this.opts.dryRun) {
      log.info(`[dry-run] ${pending.length} issue links would be created.`);
      return;
    }

    const progress = new Progress("links", pending.length);
    await pool(pending, this.cfg.concurrency, async (linkItem) => {
      try {
        await this.jira.createIssueLink(linkItem.type, linkItem.inward, linkItem.outward);
        progress.tick(true);
      } catch (err) {
        this.store.fail("links", `${linkItem.inward}↔${linkItem.outward}`, describe(err));
        progress.tick(false);
      }
    });
    progress.finish();
    for (const adoId of this.items.keys()) this.store.patchIssue(adoId, { linksDone: true });
    await this.store.flush();
  }

  /* ── 7. Attachments ───────────────────────────────────────────────────── */

  private async phaseAttachments() {
    if (!this.cfg.mapping.options.includeAttachments) return;
    log.header("Phase: attachments");

    const todo = [...this.items.entries()].filter(([adoId, item]) => {
      const rec = this.store.issue(adoId);
      return rec && !rec.attachmentsDone && item.data.attachments.some((a) => !a.skipped);
    });
    if (!todo.length) {
      log.info("No attachments to upload.");
      return;
    }

    const total = todo.reduce((n, [, i]) => n + i.data.attachments.filter((a) => !a.skipped).length, 0);
    log.info(`${total} files across ${todo.length} issues`);
    if (this.opts.dryRun) return;

    const progress = new Progress("attachments", todo.length);
    let uploaded = 0;
    let failed = 0;

    await pool(todo, Math.max(1, Math.min(2, this.cfg.concurrency)), async ([adoId, item]) => {
      const rec = this.store.issue(adoId)!;
      let anyInline = false;
      for (const att of item.data.attachments) {
        if (att.skipped) continue;
        if (this.store.data.attachments[att.guid]) {
          anyInline ||= att.inline;
          continue;
        }
        try {
          const bytes = await Deno.readFile(att.file);
          const res = await this.jira.addAttachment(rec.key, att.fileName, bytes);
          const jiraId = res?.[0]?.id;
          if (jiraId) {
            this.store.data.attachments[att.guid] = {
              id: jiraId,
              issueKey: rec.key,
              fileName: att.fileName,
            };
            this.store.touch();
          }
          anyInline ||= att.inline;
          uploaded++;
        } catch (err) {
          failed++;
          this.store.fail("attachments", `${rec.key}/${att.fileName}`, describe(err));
        }
      }

      // Embedded images: re-render the description now the Jira attachment ids are known.
      if (anyInline && item.draft.hasInlineImages) {
        try {
          const description = buildDescription(item.data.workItem, this.ctx);
          if (description.content.length) await this.jira.updateIssue(rec.key, { description });
        } catch (err) {
          this.store.fail("attachments", `${rec.key}/description`, describe(err));
        }
      }
      this.store.patchIssue(adoId, { attachmentsDone: true });
      progress.tick(true);
    });
    progress.finish();
    await this.store.flush();
    log.ok(`${uploaded} files uploaded${failed ? `, ${failed} failed` : ""}`);
  }

  private resolveImage(guid: string, fileName: string): ImageResolution | null {
    const found = this.store.data.attachments[guid];
    if (!found) return { kind: "text", text: `[image: ${fileName}]` };
    if (this.cfg.mapping.options.inlineImageMode === "media") {
      return { kind: "media", id: found.id };
    }
    return {
      kind: "link",
      href: `${this.cfg.jira.baseUrl}/rest/api/3/attachment/content/${found.id}`,
      text: `🖼 ${found.fileName}`,
    };
  }

  /* ── 8. Comments + history ────────────────────────────────────────────── */

  private async phaseComments() {
    const o = this.cfg.mapping.options;
    if (!o.includeComments && !o.includeHistory) return;
    log.header("Phase: comments + history");

    const todo = [...this.items.entries()].filter(([adoId, item]) => {
      const rec = this.store.issue(adoId);
      if (!rec) return false;
      const needComments = o.includeComments && !rec.commentsDone && item.data.comments.length > 0;
      const needHistory = o.includeHistory && !rec.historyDone && item.data.updates.length > 0;
      return needComments || needHistory;
    });
    if (!todo.length) {
      log.info("No comments or history to write.");
      return;
    }
    log.info(`${todo.length} issues have comments or history`);
    if (this.opts.dryRun) return;

    const progress = new Progress("comments", todo.length);
    await pool(todo, this.cfg.concurrency, async ([adoId, item]) => {
      const rec = this.store.issue(adoId)!;
      let ok = true;

      if (o.includeComments && !rec.commentsDone) {
        for (const comment of item.data.comments) {
          try {
            await this.jira.addComment(rec.key, buildCommentBody(comment, this.ctx));
          } catch (err) {
            ok = false;
            this.store.fail("comments", `${rec.key}#${comment.id}`, describe(err));
          }
        }
        this.store.patchIssue(adoId, { commentsDone: true });
      }

      if (o.includeHistory && !rec.historyDone) {
        const body = buildHistoryComment(item.data.updates, item.data.workItem);
        if (body) {
          try {
            await this.jira.addComment(rec.key, body);
          } catch (err) {
            ok = false;
            this.store.fail("history", rec.key, describe(err));
          }
        }
        this.store.patchIssue(adoId, { historyDone: true });
      }
      progress.tick(ok);
    });
    progress.finish();
    await this.store.flush();
  }

  /* ── 9. Assign issues to sprints ──────────────────────────────────────────── */

  private async phaseSprintAssign() {
    if (!this.cfg.mapping.options.includeSprints) return;
    log.header("Phase: sprint-assign");
    const sprints = this.store.data.sprints;
    if (!Object.keys(sprints).length) {
      log.info("No sprints exist yet -> skipping.");
      return;
    }

    const bySprint = new Map<number, { key: string; adoId: number }[]>();
    for (const [adoId, item] of this.items) {
      const rec = this.store.issue(adoId);
      if (!rec || rec.sprintDone || !item.draft.iterationPath) continue;
      const sprintId = sprints[normalizePath(item.draft.iterationPath)];
      if (!sprintId) continue;
      const list = bySprint.get(sprintId) ?? [];
      list.push({ key: rec.key, adoId });
      bySprint.set(sprintId, list);
    }

    if (this.opts.dryRun) {
      if (bySprint.size) {
        const total = [...bySprint.values()].reduce((n, l) => n + l.length, 0);
        log.info(`[dry-run] would assign ${total} issues to ${bySprint.size} sprints`);
      }
      return;
    }

    if (bySprint.size) {
      const total = [...bySprint.values()].reduce((n, l) => n + l.length, 0);
      log.info(`Assigning ${total} issues to ${bySprint.size} sprints`);
      const progress = new Progress("sprint-assign", bySprint.size);
      for (const [sprintId, members] of bySprint) {
        try {
          await this.jira.moveIssuesToSprint(sprintId, members.map((m) => m.key));
          for (const m of members) this.store.patchIssue(m.adoId, { sprintDone: true });
          progress.tick(true);
        } catch (err) {
          this.store.fail("sprint-assign", `sprint ${sprintId}`, describe(err));
          log.error(`Sprint ${sprintId}: ${describe(err)}`);
          progress.tick(false);
        }
      }
      progress.finish();
      await this.store.flush();
    } else {
      log.info("No issues need a sprint assignment.");
    }

    // A partial run (--limit/--only) has not loaded every sprint member, so
    // closing now would permanently strand the rest: a completed sprint cannot
    // be reopened via the API ("Cannot update closed sprint").
    const partial = this.opts.limit != null || (this.opts.only?.length ?? 0) > 0;
    if (this.cfg.mapping.options.closeCompletedSprints && this.board && !partial) {
      await this.closePastSprints();
      await this.startCurrentSprint();
    }
  }

  /** Activate the sprint ADO marks "current" so it shows under the board's Active sprints. */
  private async startCurrentSprint() {
    const iterations = await this.layout.readIterations();
    const current = iterations.find((i) => i.timeFrame === "current");
    if (!current) return;
    const sprintId = this.store.data.sprints[current.path];
    if (!sprintId) return;
    try {
      await this.jira.updateSprint(sprintId, {
        state: "active",
        // Jira only activates a sprint that has both dates.
        ...(current.startDate && current.finishDate
          ? { startDate: current.startDate, endDate: current.finishDate }
          : {}),
      });
      log.ok(`Started current sprint "${sprintName(current)}" (id ${sprintId})`);
    } catch (err) {
      log.warn(`Could not start current sprint "${current.path}": ${describe(err)}`);
    }
  }

  /** Close sprints that already ended in ADO so the Jira board reflects reality. */
  private async closePastSprints() {
    const iterations = await this.layout.readIterations();
    const byPath = new Map(iterations.map((i) => [i.path, i]));
    const past = Object.entries(this.store.data.sprints)
      .filter(([path]) => byPath.get(path)?.timeFrame === "past");
    if (!past.length) return;

    log.step(`Closing ${past.length} finished sprints`);
    for (const [path, sprintId] of past) {
      try {
        // Jira requires the future -> active -> closed sequence.
        await this.jira.updateSprint(sprintId, { state: "active" }).catch(() => {});
        await this.jira.updateSprint(sprintId, { state: "closed" });
      } catch (err) {
        log.warn(`Could not close sprint "${path}": ${describe(err)}`);
      }
    }
  }

  /* ── 10. Rank ─────────────────────────────────────────────────────────── */

  private async phaseRank() {
    if (!this.cfg.mapping.options.includeRank) return;
    log.header("Phase: rank (backlog order)");
    if (!this.board) {
      log.warn("No board -> skipping rank.");
      return;
    }

    const ranked = [...this.items.values()]
      .filter((i) => this.store.issue(i.draft.adoId))
      .sort((a, b) => a.draft.rank - b.draft.rank || a.draft.adoId - b.draft.adoId)
      .map((i) => this.store.issue(i.draft.adoId)!.key);

    if (ranked.length < 2) {
      log.info("Not enough issues to order.");
      return;
    }
    log.info(`Ordering ${ranked.length} issues by the ADO StackRank`);
    if (this.opts.dryRun) return;

    try {
      // Anchor on the first issue, then rank the rest after it in order.
      await this.jira.rankAfter(ranked.slice(1), ranked[0]);
      log.ok("Backlog order applied");
    } catch (err) {
      this.store.fail("rank", "backlog", describe(err));
      log.error(`Rank failed: ${describe(err)}`);
    }
  }

  /* ── 11. Transitions ──────────────────────────────────────────────────── */

  private async phaseTransitions() {
    log.header("Phase: transitions (final status)");
    const todo = [...this.items.entries()].filter(([adoId]) => {
      const rec = this.store.issue(adoId);
      return rec && !rec.transitionDone;
    });
    if (!todo.length) {
      log.info("No issues need a status transition.");
      return;
    }
    if (this.opts.dryRun) {
      const counts: Record<string, number> = {};
      for (const [, item] of todo) {
        counts[item.draft.targetStatus] = (counts[item.draft.targetStatus] ?? 0) + 1;
      }
      log.info("[dry-run] target statuses:", counts);
      return;
    }

    const progress = new Progress("transitions", todo.length);
    let skipped = 0;
    await pool(todo, this.cfg.concurrency, async ([adoId, item]) => {
      const rec = this.store.issue(adoId)!;
      const target = item.draft.targetStatus;
      if (!this.knownStatuses.has(target.toLowerCase())) {
        skipped++;
        this.store.patchIssue(adoId, { transitionDone: true });
        progress.tick(true);
        return;
      }
      try {
        const done = await this.jira.transitionTo(rec.key, target);
        if (!done) {
          this.store.fail("transitions", rec.key, `No transition path to "${target}"`);
          progress.tick(false);
          return;
        }
        this.store.patchIssue(adoId, { transitionDone: true });
        progress.tick(true);
      } catch (err) {
        this.store.fail("transitions", rec.key, describe(err));
        progress.tick(false);
      }
    });
    progress.finish();
    if (skipped) log.warn(`${skipped} issues target a status absent from the workflow -> left unchanged.`);
    await this.store.flush();
  }

  /* ── Summary ─────────────────────────────────────────────────────────── */

  private async summary() {
    await this.store.flush();
    log.header("Summary");
    const created = Object.keys(this.store.data.issues).length;
    log.ok(`${created}/${this.items.size} issues created in ${this.cfg.jira.projectKey}`);
    log.info(
      `${Object.keys(this.store.data.sprints).length} sprint · ` +
        `${Object.keys(this.store.data.attachments).length} attachment`,
    );

    const failures = this.store.data.failures;
    if (failures.length) {
      const byPhase: Record<string, number> = {};
      for (const f of failures) byPhase[f.phase] = (byPhase[f.phase] ?? 0) + 1;
      log.warn(`${failures.length} failures recorded:`, byPhase);
      for (const f of failures.slice(-10)) log.warn(`  [${f.phase}] ${f.ref}: ${f.message.slice(0, 160)}`);
      log.info(`Full detail in ${this.store.path}`);
    }
    log.info(`Re-run import at any time to finish what is missing; it is idempotent.`);
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Boards that can hold sprints. The Jira UI calls them all "Agile board", but
 * the API distinguishes them: `scrum` is a company-managed Scrum board, `simple`
 * is a team-managed (next-gen) board, which also has sprints once the Sprints
 * feature is enabled. Only `kanban` never has sprints.
 */
const BOARDS_WITH_SPRINTS = new Set(["scrum", "simple"]);

type NestingStrategy = "parent" | "epicLink" | "relates" | "none";

const STRATEGY_LABEL: Record<string, string> = {
  parent: 'field "parent"',
  epicLink: "Epic Link",
  relates: 'link "Relates"',
  none: "no parent issue yet",
};

/** Fields never dropped on retry; without them creating the issue is pointless. */
const PROTECTED_FIELDS = new Set(["project", "issuetype", "summary"]);

function extractFieldErrors(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { errors?: Record<string, string> };
    return Object.keys(parsed.errors ?? {});
  } catch {
    return [];
  }
}

function identityKey(identity: AdoIdentity | undefined): string | null {
  if (!identity) return null;
  return (identity.uniqueName ?? identity.displayName ?? "").toLowerCase() || null;
}

function sprintName(iteration: FlatIteration): string {
  // Nested iterations (Release 1\Sprint 3) need a unique name on the board.
  const parts = iteration.path.split("\\").slice(1);
  const name = parts.join(" / ") || iteration.name;
  return name.length > 120 ? name.slice(0, 117) + "..." : name;
}

function describe(err: unknown): string {
  if (err instanceof HttpError) return `HTTP ${err.status} — ${err.detail}`;
  return (err as Error)?.message ?? String(err);
}

/** Order work items so a parent always precedes its children. */
function topoSortByParent(items: Map<number, LoadedItem>): number[] {
  const out: number[] = [];
  const state = new Map<number, 0 | 1 | 2>();

  const visit = (id: number) => {
    const seen = state.get(id);
    if (seen === 2) return;
    if (seen === 1) return; // cycle in the ADO data — skip this edge
    state.set(id, 1);
    const parent = items.get(id)?.draft.parentAdoId;
    if (parent && items.has(parent)) visit(parent);
    state.set(id, 2);
    out.push(id);
  };

  for (const id of items.keys()) visit(id);
  return out;
}
