import type { Config } from "./config.ts";
import { mapValue } from "./config.ts";
import { log } from "./log.ts";
import { DataLayout } from "./ado/export.ts";
import { normalizePath, stripProject } from "./ado/iterations.ts";
import { AdoClient } from "./ado/client.ts";
import { JiraClient } from "./jira/client.ts";
import { Store } from "./util/state.ts";
import { pool } from "./util/pool.ts";

/**
 * `queries` — list saved Azure DevOps queries with their GUIDs, for use with
 * `deno task export --query=<id>`.
 */
export async function runQueries(cfg: Config): Promise<void> {
  const ado = new AdoClient(cfg);
  log.header(`Saved queries in ${cfg.ado.org}/${cfg.ado.project}`);

  const project = await ado.verifyAccess();
  log.ok(`Connected to ADO: ${project.name}`);

  const queries = await ado.listQueries();
  if (!queries.length) {
    log.warn(
      "No saved queries. Open the query in the web UI and click Save query — " +
        'a URL containing "tempQueryId" is temporary and cannot be called through the API.',
    );
    return;
  }

  const tree = queries.filter((q) => q.queryType && q.queryType !== "flat");
  console.log(`\n${queries.length} queries (${tree.length} tree-shaped, preserving parent-child):\n`);
  for (const q of queries) {
    const kind = q.queryType ?? "?";
    const marker = kind === "flat" ? " " : "*";
    console.log(`${marker} ${q.path}`);
    console.log(`    id=${q.id}  type=${kind}`);
  }

  console.log(
    `\n(*) tree/oneHop queries already return parent-child relations — prefer them.\n\n` +
      `Export using a query:\n` +
      `  deno task export --query=${queries[0].id}\n` +
      `  deno task export --query="${queries[0].path}"`,
  );
}

/**
 * `whoami` — the smallest possible connection test.
 *
 * Deliberately avoids JIRA_PROJECT_KEY so credentials can be verified before
 * the target project is even chosen, and reports which auth scheme was used so
 * a PAT-sent-as-Basic mistake is obvious.
 */
export async function runWhoami(cfg: Config): Promise<void> {
  const jira = new JiraClient(cfg);
  log.header("Jira connection test");

  const scheme = cfg.jira.authScheme === "auto" ? (cfg.jira.email ? "basic" : "bearer") : cfg.jira.authScheme;
  console.log(`URL         : ${cfg.jira.baseUrl}`);
  console.log(
    `Auth        : ${scheme}${scheme === "basic" ? ` (email ${cfg.jira.email})` : " (token as Bearer)"}`,
  );
  if (scheme === "basic" && !cfg.jira.email) {
    log.warn("Basic auth was selected but JIRA_EMAIL is empty.");
  }
  if (scheme === "basic" && cfg.jira.email && !cfg.jira.baseUrl.includes("atlassian.net")) {
    log.warn(
      "This looks like a self-hosted Jira but JIRA_EMAIL is set, so the token is sent as " +
        "Basic auth. Personal Access Tokens require Bearer — clear JIRA_EMAIL.",
    );
  }

  const { deployment, info, confirmed } = await jira.detectDeployment();
  const edition = deployment === "server" ? "Server / Data Center" : "Cloud";
  if (confirmed) {
    log.ok(
      `Reached Jira ${edition}` +
        `${info.version ? ` v${info.version}` : ""}${info.serverTitle ? ` — ${info.serverTitle}` : ""}`,
    );
  } else {
    // /serverInfo gave nothing usable, so this is still only a hostname guess.
    log.warn(`Assuming Jira ${edition} from the hostname — /serverInfo did not answer with JSON.`);
  }

  const me = await jira.myself();
  log.ok(`Authenticated as ${me.displayName}${me.emailAddress ? ` <${me.emailAddress}>` : ""}`);

  // Listing projects here is the whole point: the key has to come from
  // somewhere, and this is the only command that runs without one.
  const projects = await jira.listProjects().catch((err) => {
    log.warn(`Could not list projects: ${(err as Error).message.slice(0, 160)}`);
    return [] as { key: string; name: string }[];
  });

  if (projects.length) {
    console.log(`\n${projects.length} project(s) you can browse:`);
    for (const p of projects.slice(0, 50)) console.log(`  ${p.key.padEnd(12)} ${p.name}`);
    if (projects.length > 50) console.log(`  … and ${projects.length - 50} more`);
  }

  const current = cfg.jira.projectKey;
  if (!current) {
    console.log(`\nConnection works. Set JIRA_PROJECT_KEY in .env, then run \`deno task fields\`.`);
  } else if (projects.some((p) => p.key.toUpperCase() === current)) {
    log.ok(`JIRA_PROJECT_KEY=${current} matches a visible project.`);
    console.log(`\nConnection works. Next: \`deno task fields\`.`);
  } else {
    log.warn(`JIRA_PROJECT_KEY=${current} is not in the list above.`);
  }
}

/**
 * `fields` — print the destination Jira project metadata to fill migration.config.json.
 * Writes nothing to Jira.
 */
export async function runFields(cfg: Config): Promise<void> {
  const jira = new JiraClient(cfg);
  log.header(`Metadata for Jira project ${cfg.jira.projectKey}`);

  const { deployment, info } = await jira.detectDeployment();
  log.ok(
    `Jira edition: ${deployment === "server" ? "Server / Data Center" : "Cloud"}` +
      `${info.version ? ` v${info.version}` : ""}${info.serverTitle ? ` — ${info.serverTitle}` : ""}`,
  );
  console.log(
    deployment === "server"
      ? "  -> uses REST API v2, descriptions as wiki markup, assignee by username.\n" +
        "  -> links issues to an Epic via the Epic Link custom field (see below), not parent."
      : "  -> uses REST API v3, descriptions as ADF, assignee by accountId.",
  );

  const me = await jira.myself();
  log.ok(`Signed in as: ${me.displayName}`);

  const project = await jira.getProject();
  console.log(`\nProject: ${project.key} — ${project.name} (${project.style ?? "classic"})`);

  console.log(`\nIssue types:`);
  for (const it of project.issueTypes ?? []) {
    console.log(
      `  ${it.name.padEnd(22)} id=${it.id.padEnd(6)} hierarchyLevel=${it.hierarchyLevel ?? "?"}` +
        (it.subtask ? " (subtask)" : ""),
    );
  }

  // Grouped by issue type, because a project may run a different workflow per
  // type and a status is only reachable for the types that actually have it.
  const byType = await jira.getStatusesByType().catch(() => []);
  console.log(`\nStatuses (for the "status" section of the config):`);
  if (byType.length) {
    for (const t of byType) console.log(`  ${t.issueType.padEnd(12)} ${t.statuses.join(", ")}`);
    const workflows = new Set(byType.map((t) => [...t.statuses].sort().join("|")));
    if (workflows.size > 1) {
      console.log(
        `\n  ${workflows.size} distinct workflows in this project. A status mapping only applies\n` +
          `  to the issue types that actually have that status; the rest keep their default.`,
      );
    }
  } else {
    for (const s of await jira.getStatuses()) console.log(`  ${s.name}`);
  }

  const linkTypes = await jira.getIssueLinkTypes();
  console.log(`\nIssue link types (for "linkType".name):`);
  for (const t of linkTypes) {
    console.log(`  ${t.name.padEnd(16)} inward="${t.inward}" outward="${t.outward}"`);
  }

  const components = await jira.getComponents();
  console.log(`\nComponents: ${components.length ? components.map((c) => c.name).join(", ") : "(none yet)"}`);

  // The Jira UI calls them all "Agile board"; only the API distinguishes the
  // type, and the type decides whether sprints exist.
  const boards = await jira.getBoards().catch(() => []);
  console.log(`\nBoards:`);
  if (!boards.length) {
    console.log("  (no boards — a Scrum or team-managed board is required to migrate sprints)");
  }
  const SPRINT_NOTE: Record<string, string> = {
    scrum: "has sprints (company-managed Scrum)",
    simple: "has sprints once Features -> Sprints is enabled (team-managed)",
    kanban: "NO sprints",
  };
  for (const b of boards) {
    console.log(
      `  ${b.name.padEnd(28)} id=${b.id}  type=${b.type.padEnd(7)} → ${SPRINT_NOTE[b.type] ?? "?"}`,
    );
  }
  const usable = boards.filter((b) => b.type === "scrum" || b.type === "simple");
  if (boards.length && !usable.length) {
    log.warn(
      "No board can hold sprints. Set options.includeSprints = false to skip them, " +
        "or create a Scrum board.",
    );
  } else if (usable.length > 1) {
    console.log(`\n  ${usable.length} usable boards — pick one with JIRA_BOARD_NAME in .env.`);
  }

  const fields = await jira.getFields();
  const interesting = fields.filter((f) =>
    f.custom &&
    /story point|sprint|epic link|epic name|start date|original estimate|rank|azure|devops|ado/i.test(f.name)
  );
  console.log(`\nRelevant custom fields (for the "fields" section of the config):`);
  for (const f of interesting) {
    console.log(`  ${f.id.padEnd(20)} ${f.name.padEnd(28)} ${f.schema?.custom?.split(":").pop() ?? ""}`);
  }
  console.log(`\n  (${fields.length} fields total; filter with: deno task fields | findstr /i "field name")`);

  console.log(
    `\nSuggested "fields" config:\n` + JSON.stringify(
      {
        storyPoints: pick(interesting, /story point/i, "Story Points"),
        sprint: pick(interesting, /^sprint$/i, "Sprint"),
        epicLink: pick(interesting, /epic link/i, "Epic Link"),
        startDate: pick(interesting, /^start date$/i, "Start date"),
        adoId: pick(interesting, /azure devops id|ado id/i),
      },
      null,
      2,
    ),
  );
}

/**
 * Suggest a custom field, preferring an exact name match.
 *
 * A plain "first regex hit" is actively misleading on real instances: searching
 * for "story point" also matches Advanced Roadmaps' "Original story points",
 * and "start date" matches unrelated fields like "Change start date". Picking
 * the wrong one silently writes data into the wrong field.
 */
function pick(fields: { id: string; name: string }[], re: RegExp, exact?: string): string | null {
  if (exact) {
    const hit = fields.find((f) => f.name.trim().toLowerCase() === exact.toLowerCase());
    if (hit) return hit.id;
  }
  const matches = fields.filter((f) => re.test(f.name));
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0].id;
  // Several candidates and none exact: the shortest name is the least qualified,
  // so it is the most likely to be the plain field rather than a variant.
  return [...matches].sort((a, b) => a.name.length - b.name.length)[0].id;
}

/**
 * `plan` — analyse the exported data and print the migration plan.
 * Reads local files only; never calls Jira.
 */
export async function runPlan(cfg: Config): Promise<void> {
  const layout = new DataLayout(cfg.dataDir);
  const manifest = await layout.readManifest();
  const iterations = await layout.readIterations();

  log.header("Migration plan");
  console.log(`Source: ${manifest.org}/${manifest.project} (exported at ${manifest.exportedAt})`);
  console.log(`Target: ${cfg.jira.baseUrl} / ${cfg.jira.projectKey}\n`);

  console.log(`Work item → issue type:`);
  const unmappedTypes: string[] = [];
  for (const [adoType, count] of Object.entries(manifest.typeCounts).sort((a, b) => b[1] - a[1])) {
    const target = mapValue(cfg.mapping.issueType, adoType);
    const explicit = cfg.mapping.issueType[adoType] !== undefined;
    if (!explicit) unmappedTypes.push(adoType);
    console.log(
      `  ${adoType.padEnd(24)} ${String(count).padStart(6)} -> ${target}${explicit ? "" : "  (default)"}`,
    );
  }

  console.log(`\nState → status:`);
  const unmappedStates: string[] = [];
  for (const [state, count] of Object.entries(manifest.stateCounts).sort((a, b) => b[1] - a[1])) {
    const target = mapValue(cfg.mapping.status, state);
    const explicit = cfg.mapping.status[state] !== undefined;
    if (!explicit) unmappedStates.push(state);
    console.log(
      `  ${state.padEnd(24)} ${String(count).padStart(6)} -> ${target}${explicit ? "" : "  (default)"}`,
    );
  }

  // Which iterations are actually used, and which users need mapping.
  const usedIterations = new Set<string>();
  const areas = new Set<string>();
  const users = new Set<string>();
  const typeById = new Map<number, string>();
  const parentById = new Map<number, number>();
  let relations = 0;

  for (const id of manifest.workItemIds) {
    const item = await layout.readWorkItem(id);
    if (!item) continue;
    const f = item.workItem.fields;
    if (f["System.IterationPath"]) usedIterations.add(normalizePath(f["System.IterationPath"]));
    const area = stripProject(f["System.AreaPath"] ?? "");
    if (area) areas.add(area);
    for (const identity of [f["System.AssignedTo"], f["System.CreatedBy"]]) {
      if (identity?.uniqueName) users.add(identity.uniqueName);
    }
    typeById.set(id, String(f["System.WorkItemType"] ?? ""));
    if (typeof f["System.Parent"] === "number") parentById.set(id, f["System.Parent"]);
    for (const rel of item.workItem.relations ?? []) {
      if (cfg.mapping.linkType[rel.rel]) relations++;
    }
  }
  const parents = parentById.size;

  const sprintsToCreate = iterations.filter((i) => usedIterations.has(i.path));
  console.log(`\nSprints to create: ${sprintsToCreate.length}/${iterations.length} iterations in use`);
  for (const s of sprintsToCreate.slice(0, 15)) {
    console.log(
      `  ${s.path.padEnd(40)} ${s.startDate?.slice(0, 10) ?? "?"} → ${
        s.finishDate?.slice(0, 10) ?? "?"
      }  [${s.timeFrame}]`,
    );
  }
  if (sprintsToCreate.length > 15) console.log(`  … and ${sprintsToCreate.length - 15} more sprints`);

  printHierarchyPlan(cfg, typeById, parentById);

  console.log(`\nRelations: ${parents} parent-child · ${relations} links (mapped)`);
  console.log(`Content:   ${manifest.commentCount} comments · ${manifest.attachmentCount} attachments`);
  console.log(`Area paths: ${areas.size} (-> labels prefixed "${cfg.mapping.labels.areaPathPrefix}")`);
  console.log(`Users to map: ${users.size}`);

  if (unmappedTypes.length || unmappedStates.length) {
    log.warn(
      `No mapping declared for:` +
        (unmappedTypes.length ? `\n  work item type: ${unmappedTypes.join(", ")}` : "") +
        (unmappedStates.length ? `\n  state: ${unmappedStates.join(", ")}` : "") +
        `\nThey will fall back to "_default". Add them to migration.config.json for precision.`,
    );
  }
  console.log(
    `\nRun \`deno task import --dry-run\` to inspect the payload, then \`deno task import\` to execute.`,
  );
}

/**
 * `verify` — reconcile the exported data against what actually exists in Jira.
 */
export async function runVerify(cfg: Config): Promise<void> {
  const layout = new DataLayout(cfg.dataDir);
  const manifest = await layout.readManifest();
  const store = await Store.open(cfg.stateDir, cfg.jira.projectKey);
  const jira = new JiraClient(cfg);

  log.header("Reconciling ADO against Jira");
  const expected = manifest.workItemIds;
  const mapped = expected.filter((id) => store.issue(id));
  const notMigrated = expected.filter((id) => !store.issue(id));

  console.log(`Work item trong export : ${expected.length}`);
  console.log(`Issues created         : ${mapped.length}`);
  console.log(`Not migrated           : ${notMigrated.length}`);

  if (notMigrated.length) {
    console.log(`  ${notMigrated.slice(0, 30).join(", ")}${notMigrated.length > 30 ? " …" : ""}`);
  }

  log.step("Checking a sample of issues really exist in Jira");
  const sample = mapped.length > 200 ? sampleEvenly(mapped, 200) : mapped;
  let missing = 0;
  let statusMismatch = 0;

  const results = await pool(sample, cfg.concurrency, async (adoId) => {
    const rec = store.issue(adoId)!;
    const issue = await jira.getIssue(rec.key, "status,summary");
    if (!issue) return { adoId, key: rec.key, missing: true, status: null };
    const status = (issue.fields.status as { name?: string } | undefined)?.name ?? null;
    return { adoId, key: rec.key, missing: false, status };
  });

  for (const r of results) {
    if (r.missing) {
      missing++;
      log.error(`${r.key} (ADO #${r.adoId}) does not exist in Jira — the state file is out of sync.`);
      continue;
    }
    const item = await layout.readWorkItem(r.adoId);
    const target = mapValue(cfg.mapping.status, item?.workItem.fields["System.State"]);
    if (target && r.status && target.toLowerCase() !== r.status.toLowerCase()) {
      statusMismatch++;
      log.debug(`${r.key}: status "${r.status}" != expected "${target}"`);
    }
  }

  console.log(`\nSample checked         : ${sample.length}`);
  console.log(`Missing in Jira         : ${missing}`);
  console.log(`Status mismatches       : ${statusMismatch}`);

  const failures = store.data.failures;
  if (failures.length) {
    const byPhase: Record<string, number> = {};
    for (const f of failures) byPhase[f.phase] = (byPhase[f.phase] ?? 0) + 1;
    log.warn(`${failures.length} failures recorded, by phase:`, byPhase);
  } else {
    log.ok("No failures recorded.");
  }

  console.log(`\nSprints created  : ${Object.keys(store.data.sprints).length}`);
  console.log(`Attachment upload: ${Object.keys(store.data.attachments).length}/${manifest.attachmentCount}`);
  await store.close();
}

/**
 * Hierarchy levels of the standard Jira Software issue types. Used only for the
 * `plan` estimate, which never calls Jira; `preflight` reads the project's real
 * levels, including custom Advanced Roadmaps tiers.
 */
const STANDARD_LEVEL: Record<string, number> = {
  "epic": 1,
  "story": 0,
  "task": 0,
  "bug": 0,
  "improvement": 0,
  "new feature": 0,
  "sub-task": -1,
  "subtask": -1,
};

/** Warn up front about parent-child relations the Jira hierarchy will reject. */
function printHierarchyPlan(
  cfg: Config,
  typeById: Map<number, string>,
  parentById: Map<number, number>,
): void {
  if (!parentById.size) {
    console.log(`\nHierarchy: the data contains no parent-child relations.`);
    return;
  }

  const jiraType = (adoType: string) => mapValue(cfg.mapping.issueType, adoType) ?? "Task";
  const level = (adoType: string) => STANDARD_LEVEL[jiraType(adoType).toLowerCase()];

  const ok = new Map<string, number>();
  const broken = new Map<string, number>();
  const unknown = new Map<string, number>();

  for (const [childId, parentId] of parentById) {
    const childType = typeById.get(childId);
    const parentType = typeById.get(parentId);
    if (!childType || !parentType) continue;

    const label = `${parentType} → ${childType}` +
      `  (Jira: ${jiraType(parentType)} → ${jiraType(childType)})`;
    const pl = level(parentType);
    const cl = level(childType);

    const bucket = pl === undefined || cl === undefined ? unknown : pl > cl ? ok : broken;
    bucket.set(label, (bucket.get(label) ?? 0) + 1);
  }

  const total = parentById.size;
  const brokenCount = [...broken.values()].reduce((a, b) => a + b, 0);
  console.log(`\nHierarchy: ${total} parent-child relations`);

  const dump = (title: string, table: Map<string, number>) => {
    if (!table.size) return;
    console.log(`  ${title}`);
    for (const [k, v] of [...table.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(4)}  ${k}`);
    }
  };
  dump("kept as a real parent:", ok);
  dump('CANNOT nest -> becomes a "Relates" link:', broken);
  dump("unknown (non-standard issue type; preflight will check):", unknown);

  if (brokenCount) {
    log.warn(
      `${brokenCount}/${total} relations lose their parent-child shape because Jira has only ` +
        `one tier above Story (Epic). No data is lost — they become "Relates" links.\n` +
        `  To keep the tiers, Advanced Roadmaps (Jira Premium) can add a level above Epic; ` +
        `then map the ADO "Epic" onto that level in migration.config.json.`,
    );
  }
}

function sampleEvenly<T>(items: T[], count: number): T[] {
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
}
