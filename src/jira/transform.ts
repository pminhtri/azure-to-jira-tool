import type { Config } from "../config.ts";
import { mapValue } from "../config.ts";
import { stripProject } from "../ado/iterations.ts";
import type {
  AdoComment,
  AdoIdentity,
  AdoUpdate,
  AdoWorkItem,
  AttachmentManifestEntry,
} from "../ado/types.ts";
import {
  type AdfDoc,
  type AdfNode,
  concatDocs,
  emptyDoc,
  type ImageResolution,
  link,
  panel,
  paragraph,
  text,
  textToAdf,
} from "./adf.ts";
import { richTextToAdf } from "./markdown.ts";

/** Everything the transform needs to know about the destination Jira. */
export interface TransformContext {
  cfg: Config;
  adoWebUrl: (id: number) => string;
  /** ADO uniqueName -> Jira accountId, null when it cannot be mapped. */
  resolveUser: (identity: AdoIdentity | undefined) => string | null;
  /** Which field ids may be set for this issue type. */
  allowedFields: (issueTypeName: string) => Set<string> | null;
  /** Component names that exist on the Jira project. */
  knownComponents: Set<string>;
  /** Cloud sets assignee via `{id}`, Server/DC via `{name}`. */
  assigneeRef?: (accountId: string) => Record<string, string>;
  /** Explicit "no assignee" reference so creation skips the project's default assignee. */
  unassignedRef?: () => Record<string, null>;
  /** Embedded images: GUID -> how to render it, known once attachments are uploaded. */
  resolveImage?: (guid: string, fileName: string) => ImageResolution | null;
}

export interface IssueDraft {
  adoId: number;
  issueTypeName: string;
  fields: Record<string, unknown>;
  /** Target Jira status, applied during the transition phase. */
  targetStatus: string;
  /** ADO parent id, if any — applied during the hierarchy phase. */
  parentAdoId: number | null;
  iterationPath: string | null;
  rank: number;
  hasInlineImages: boolean;
}

const HOURS_FIELDS = [
  ["Microsoft.VSTS.Scheduling.OriginalEstimate", "Original estimate"],
  ["Microsoft.VSTS.Scheduling.RemainingWork", "Remaining work"],
  ["Microsoft.VSTS.Scheduling.CompletedWork", "Completed work"],
] as const;

/* ── Issue ───────────────────────────────────────────────────────────────── */

export function buildIssueDraft(
  wi: AdoWorkItem,
  attachments: AttachmentManifestEntry[],
  ctx: TransformContext,
): IssueDraft {
  const { cfg } = ctx;
  const f = wi.fields;
  const adoType = f["System.WorkItemType"] ?? "";
  const issueTypeName = mapValue(cfg.mapping.issueType, adoType) ?? "Task";
  const allowed = ctx.allowedFields(issueTypeName);
  const can = (id: string) => !allowed || allowed.has(id);

  const fields: Record<string, unknown> = {
    project: { key: cfg.jira.projectKey },
    issuetype: { name: issueTypeName },
    summary: buildSummary(wi),
  };

  const description = buildDescription(wi, ctx);
  if (description.content.length && can("description")) fields.description = description;

  const assignee = ctx.resolveUser(f["System.AssignedTo"]);
  if (can("assignee")) {
    // Set it explicitly even when unmapped, else Jira applies the project default assignee (the lead).
    fields.assignee = assignee
      ? (ctx.assigneeRef ? ctx.assigneeRef(assignee) : { id: assignee })
      : (ctx.unassignedRef ? ctx.unassignedRef() : { id: null });
  }

  if (can("priority")) {
    const priority = mapValue(
      cfg.mapping.priority,
      f["Microsoft.VSTS.Common.Priority"] != null ? String(f["Microsoft.VSTS.Common.Priority"]) : undefined,
    );
    if (priority) fields.priority = { name: priority };
  }

  const labels = buildLabels(wi, cfg);
  if (labels.length && can("labels")) fields.labels = labels;

  const components = buildComponents(wi, ctx);
  if (components.length && can("components")) fields.components = components.map((name) => ({ name }));

  const due = asDate(f["Microsoft.VSTS.Scheduling.DueDate"] ?? f["Microsoft.VSTS.Scheduling.TargetDate"]);
  if (due && can("duedate")) fields.duedate = due;

  const custom = cfg.mapping.fields;
  const points = f["Microsoft.VSTS.Scheduling.StoryPoints"] ?? f["Microsoft.VSTS.Scheduling.Effort"];
  if (custom.storyPoints && typeof points === "number" && can(custom.storyPoints)) {
    fields[custom.storyPoints] = points;
  }
  // "Epic Name" is a required field for Epics on Server / Data Center; can() is
  // true only when the target issue type actually exposes it (i.e. an Epic).
  if (custom.epicName && can(custom.epicName)) {
    fields[custom.epicName] = (fields.summary as string).slice(0, 255);
  }
  if (custom.adoId && can(custom.adoId)) fields[custom.adoId] = String(wi.id);
  if (custom.adoUrl && can(custom.adoUrl)) fields[custom.adoUrl] = ctx.adoWebUrl(wi.id);
  const originalEstimate = f["Microsoft.VSTS.Scheduling.OriginalEstimate"];
  if (custom.originalEstimate && typeof originalEstimate === "number" && can(custom.originalEstimate)) {
    fields[custom.originalEstimate] = originalEstimate;
  }
  const startDate = asDate(f["Microsoft.VSTS.Scheduling.StartDate"]);
  if (custom.startDate && startDate && can(custom.startDate)) fields[custom.startDate] = startDate;

  const rank = numeric(f["Microsoft.VSTS.Common.StackRank"]) ??
    numeric(f["Microsoft.VSTS.Common.BacklogPriority"]) ??
    wi.id;

  return {
    adoId: wi.id,
    issueTypeName,
    fields,
    targetStatus: mapValue(cfg.mapping.status, f["System.State"]) ?? "To Do",
    parentAdoId: numeric(f["System.Parent"]) ?? null,
    iterationPath: f["System.IterationPath"] ?? null,
    rank,
    hasInlineImages: attachments.some((a) => a.inline && !a.skipped),
  };
}

function buildSummary(wi: AdoWorkItem): string {
  const raw = (wi.fields["System.Title"] ?? `Work item ${wi.id}`).toString();
  // Jira caps summary at 255 characters and disallows line breaks.
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > 255 ? clean.slice(0, 252) + "..." : clean || `Work item ${wi.id}`;
}

/**
 * The Jira description is a traceability panel plus the ADO description,
 * acceptance criteria, repro steps, system info, and a table of the ADO fields
 * that have no Jira field to live in.
 */
export function buildDescription(wi: AdoWorkItem, ctx: TransformContext): AdfDoc {
  const { cfg } = ctx;
  const f = wi.fields;
  const adfCtx = { resolveImage: ctx.resolveImage };
  const parts: (AdfDoc | null)[] = [];

  if (cfg.mapping.options.descriptionHeader) {
    parts.push({
      version: 1,
      type: "doc",
      content: [panel("info", [paragraph(...headerLine(wi, ctx))])],
    });
  }

  parts.push(richTextToAdf(f["System.Description"], adfCtx));
  parts.push(section("Acceptance Criteria", f["Microsoft.VSTS.Common.AcceptanceCriteria"], adfCtx));
  parts.push(section("Repro Steps", f["Microsoft.VSTS.TCM.ReproSteps"], adfCtx));
  parts.push(section("System Info", f["Microsoft.VSTS.TCM.SystemInfo"], adfCtx));

  const extras = cfg.mapping.options.descriptionExtraFields ? buildExtraFieldRows(wi, cfg) : [];
  if (extras.length) {
    parts.push({
      version: 1,
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 4 }, content: [text("Azure DevOps fields")] },
        definitionTable(extras),
      ],
    });
  }

  return concatDocs(parts);
}

function headerLine(wi: AdoWorkItem, ctx: TransformContext): AdfNode[] {
  const f = wi.fields;
  const nodes: AdfNode[] = [
    text("Migrated from Azure DevOps "),
    link(`${f["System.WorkItemType"] ?? "Work Item"} #${wi.id}`, ctx.adoWebUrl(wi.id)),
  ];
  const author = f["System.CreatedBy"]?.displayName;
  const created = f["System.CreatedDate"];
  if (author || created) {
    nodes.push(text(` · created by ${author ?? "?"}${created ? ` on ${formatDate(created)}` : ""}`));
  }
  const changed = f["System.ChangedDate"];
  if (changed) nodes.push(text(` · last updated ${formatDate(changed)}`));
  return nodes;
}

function section(
  title: string,
  html: string | undefined,
  adfCtx: { resolveImage?: TransformContext["resolveImage"] },
): AdfDoc | null {
  const body = richTextToAdf(html, adfCtx);
  if (!body.content.length) return null;
  return {
    version: 1,
    type: "doc",
    content: [{ type: "heading", attrs: { level: 4 }, content: [text(title)] }, ...body.content],
  };
}

/** ADO fields with no Jira home -> kept as a table so nothing is lost. */
function buildExtraFieldRows(wi: AdoWorkItem, cfg: Config): [string, string][] {
  const f = wi.fields;
  const rows: [string, string][] = [];
  const push = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    rows.push([label, String(value)]);
  };

  push("Work item type", f["System.WorkItemType"]);
  push("Area Path", f["System.AreaPath"]);
  push("Iteration Path", f["System.IterationPath"]);
  push("State", `${f["System.State"] ?? ""}${f["System.Reason"] ? ` (${f["System.Reason"]})` : ""}`);
  push("Severity", f["Microsoft.VSTS.Common.Severity"]);
  push("Value Area", f["Microsoft.VSTS.Common.ValueArea"]);
  push("Board Column", f["System.BoardColumn"]);
  push("Created by", f["System.CreatedBy"]?.displayName);
  push("Created date", f["System.CreatedDate"] ? formatDate(f["System.CreatedDate"]) : undefined);
  push("Changed by", f["System.ChangedBy"]?.displayName);
  push(
    "Resolved date",
    f["Microsoft.VSTS.Common.ResolvedDate"] ? formatDate(f["Microsoft.VSTS.Common.ResolvedDate"]) : undefined,
  );
  push(
    "Closed date",
    f["Microsoft.VSTS.Common.ClosedDate"] ? formatDate(f["Microsoft.VSTS.Common.ClosedDate"]) : undefined,
  );

  for (const [key, label] of HOURS_FIELDS) {
    const v = f[key];
    if (typeof v === "number") push(label, `${v}h`);
  }
  if (!cfg.mapping.fields.storyPoints) {
    const pts = f["Microsoft.VSTS.Scheduling.StoryPoints"] ?? f["Microsoft.VSTS.Scheduling.Effort"];
    if (typeof pts === "number") push("Story points", pts);
  }
  return rows;
}

function definitionTable(rows: [string, string][]): AdfNode {
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: rows.map(([k, v]) => ({
      type: "tableRow",
      content: [
        { type: "tableHeader", attrs: {}, content: [paragraph(text(k))] },
        { type: "tableCell", attrs: {}, content: [paragraph(text(v))] },
      ],
    })),
  };
}

function buildLabels(wi: AdoWorkItem, cfg: Config): string[] {
  const out = new Set<string>();
  const { labels } = cfg.mapping;

  if (labels.fromTags) {
    const tags = (wi.fields["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean);
    for (const tag of tags) out.add(sanitizeLabel(tag));
  }
  if (labels.fromAreaPath) {
    const area = stripProject(wi.fields["System.AreaPath"] ?? "");
    if (area) out.add(sanitizeLabel(labels.areaPathPrefix + area.replace(/\\/g, "-")));
  }
  if (labels.fromWorkItemType) {
    // Jira collapses ADO's Epic and Feature into one Epic issue type, so this
    // label is the only place the distinction survives.
    const type = wi.fields["System.WorkItemType"];
    if (type) out.add(sanitizeLabel(labels.workItemTypePrefix + type));
  }
  for (const extra of labels.extra ?? []) out.add(sanitizeLabel(extra));

  return [...out].filter(Boolean).slice(0, 50);
}

function buildComponents(wi: AdoWorkItem, ctx: TransformContext): string[] {
  const { components } = ctx.cfg.mapping;
  const area = stripProject(wi.fields["System.AreaPath"] ?? "");
  if (!area) return [];

  const explicit = components.map[area] ?? components.map[wi.fields["System.AreaPath"] ?? ""];
  if (explicit) return ctx.knownComponents.has(explicit) ? [explicit] : [];
  if (!components.fromAreaPath) return [];

  // Try the full path first, then progressively shorter prefixes.
  const segments = area.split("\\");
  for (let i = segments.length; i > 0; i--) {
    const candidate = segments.slice(0, i).join(" / ");
    if (ctx.knownComponents.has(candidate)) return [candidate];
  }
  const leaf = segments[segments.length - 1];
  return ctx.knownComponents.has(leaf) ? [leaf] : [];
}

/**
 * Jira labels cannot contain whitespace but do accept Unicode, so diacritics
 * are preserved; only whitespace is replaced and control characters removed.
 */
export function sanitizeLabel(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, "-")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f"]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

/* ── Comments ────────────────────────────────────────────────────────────── */

export function buildCommentBody(comment: AdoComment, ctx: TransformContext): AdfDoc {
  const body = richTextToAdf(comment.text, { resolveImage: ctx.resolveImage });
  const content = body.content.length ? body : textToAdf("(empty content)");

  if (!ctx.cfg.mapping.options.commentAttribution) return content;

  const who = comment.createdBy?.displayName ?? comment.createdBy?.uniqueName ?? "Unknown";
  const when = comment.createdDate ? formatDate(comment.createdDate) : "";

  return concatDocs([
    {
      version: 1,
      type: "doc",
      content: [paragraph(
        text(`${who}`, [{ type: "strong" }]),
        text(when ? ` — ${when} (comment from Azure DevOps)` : " (comment from Azure DevOps)", [{
          type: "em",
        }]),
      )],
    },
    content,
  ]);
}

/* ── History ─────────────────────────────────────────────────────────────── */

const HISTORY_TRACKED: Record<string, string> = {
  "System.State": "State",
  "System.AssignedTo": "Assigned To",
  "System.IterationPath": "Iteration",
  "System.AreaPath": "Area",
  "System.Title": "Title",
  "System.Tags": "Tags",
  "Microsoft.VSTS.Common.Priority": "Priority",
  "Microsoft.VSTS.Common.Severity": "Severity",
  "Microsoft.VSTS.Scheduling.StoryPoints": "Story Points",
  "Microsoft.VSTS.Scheduling.RemainingWork": "Remaining Work",
  "Microsoft.VSTS.Scheduling.OriginalEstimate": "Original Estimate",
  "Microsoft.VSTS.Scheduling.CompletedWork": "Completed Work",
};

/**
 * Compress the entire ADO revision history into a single table comment.
 * Jira does not allow writing changelog entries, so this is the only way to
 * preserve the history.
 */
export function buildHistoryComment(updates: AdoUpdate[], wi: AdoWorkItem): AdfDoc | null {
  const rows: AdfNode[] = [];

  for (const update of updates) {
    const changes: string[] = [];
    for (const [field, change] of Object.entries(update.fields ?? {})) {
      const label = HISTORY_TRACKED[field];
      if (!label) continue;
      const from = displayValue(change.oldValue);
      const to = displayValue(change.newValue);
      if (from === to) continue;
      changes.push(`${label}: ${from || "∅"} → ${to || "∅"}`);
    }
    for (const rel of update.relations?.added ?? []) {
      changes.push(
        `+ link ${shortRel(rel.rel)}${rel.attributes?.name ? ` (${rel.attributes.name})` : ""}`,
      );
    }
    for (const rel of update.relations?.removed ?? []) {
      changes.push(`− link ${shortRel(rel.rel)}`);
    }
    if (!changes.length) continue;

    rows.push({
      type: "tableRow",
      content: [
        cell(update.revisedDate ? formatDate(update.revisedDate) : `rev ${update.rev}`),
        cell(update.revisedBy?.displayName ?? update.revisedBy?.uniqueName ?? "?"),
        cell(changes.join("\n")),
      ],
    });
  }

  if (!rows.length) return null;

  // Keep the 200 most recent changes so the comment stays under Jira's limit.
  const capped = rows.length > 200;
  const shown = capped ? rows.slice(-200) : rows;

  const content: AdfNode[] = [
    paragraph(text(`Change history from Azure DevOps #${wi.id}`, [{ type: "strong" }])),
  ];
  if (capped) {
    content.push(
      paragraph(text(`(showing the 200 most recent of ${rows.length} changes)`, [{ type: "em" }])),
    );
  }
  content.push({
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: [
      {
        type: "tableRow",
        content: [headerCell("When"), headerCell("Changed by"), headerCell("Change")],
      },
      ...shown,
    ],
  });

  return { version: 1, type: "doc", content };
}

function cell(value: string): AdfNode {
  const lines = value.split("\n").filter(Boolean);
  return {
    type: "tableCell",
    attrs: {},
    content: lines.length ? lines.map((l) => paragraph(text(l))) : [paragraph()],
  };
}

function headerCell(value: string): AdfNode {
  return { type: "tableHeader", attrs: {}, content: [paragraph(text(value, [{ type: "strong" }]))] };
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const id = value as AdoIdentity;
    if (id.displayName) return id.displayName;
    return JSON.stringify(value).slice(0, 120);
  }
  const s = String(value);
  return s.length > 160 ? s.slice(0, 157) + "..." : s;
}

const shortRel = (rel: string) =>
  rel.replace(/^System\.LinkTypes\./, "").replace(/^Microsoft\.VSTS\.Common\./, "");

/* ── Helpers ─────────────────────────────────────────────────────────────── */

export function asDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export { emptyDoc };
