import assert from "node:assert/strict";
import type { AdoUpdate, AdoWorkItem } from "../ado/types.ts";
import { makeConfig } from "../testing/fixtures.ts";
import { buildHistoryComment, buildIssueDraft, sanitizeLabel, type TransformContext } from "./transform.ts";

function makeCtx(cfg = makeConfig(), overrides: Partial<TransformContext> = {}): TransformContext {
  return {
    cfg,
    adoWebUrl: (id) => `https://dev.azure.com/contoso/Web/_workitems/edit/${id}`,
    resolveUser: (identity) => (identity?.uniqueName === "an@contoso.com" ? "acc-123" : null),
    allowedFields: () => null,
    knownComponents: new Set(),
    ...overrides,
  };
}

const workItem = (fields: Partial<AdoWorkItem["fields"]>, id = 42): AdoWorkItem => ({
  id,
  rev: 3,
  url: `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`,
  fields: {
    "System.Id": id,
    "System.WorkItemType": "User Story",
    "System.Title": "Sign in with SSO",
    "System.State": "Active",
    ...fields,
  },
});

Deno.test("maps issue type, status, priority and assignee", () => {
  const ctx = makeCtx();
  const draft = buildIssueDraft(
    workItem({
      "System.AssignedTo": { displayName: "An", uniqueName: "an@contoso.com" },
      "Microsoft.VSTS.Common.Priority": 1,
    }),
    [],
    ctx,
  );

  assert.equal(draft.issueTypeName, "Story");
  assert.equal(draft.targetStatus, "In Progress");
  assert.deepEqual(draft.fields.issuetype, { name: "Story" });
  assert.deepEqual(draft.fields.project, { key: "WEB" });
  assert.deepEqual(draft.fields.assignee, { id: "acc-123" });
  assert.deepEqual(draft.fields.priority, { name: "Highest" });
});

Deno.test("an unknown work item type falls back to _default", () => {
  const draft = buildIssueDraft(workItem({ "System.WorkItemType": "Impediment" }), [], makeCtx());
  assert.equal(draft.issueTypeName, "Task");
});

Deno.test("an unmappable assignee is explicitly unassigned", () => {
  const draft = buildIssueDraft(
    workItem({ "System.AssignedTo": { displayName: "Someone", uniqueName: "other@contoso.com" } }),
    [],
    makeCtx(),
  );
  // Explicit null, not omitted, so Jira does not fall back to the project default assignee.
  assert.deepEqual(draft.fields.assignee, { id: null });
});

Deno.test("summary is capped at 255 characters with line breaks removed", () => {
  const draft = buildIssueDraft(workItem({ "System.Title": "a\nb " + "x".repeat(400) }), [], makeCtx());
  const summary = draft.fields.summary as string;
  assert.equal(summary.length <= 255, true);
  assert.equal(summary.includes("\n"), false);
  assert.equal(summary.startsWith("a b"), true);
});

Deno.test("tags and area path become valid labels", () => {
  const draft = buildIssueDraft(
    workItem({
      "System.Tags": "urgent; tech debt ;   ",
      "System.AreaPath": "Web\\Team A\\Frontend",
    }),
    [],
    makeCtx(),
  );
  const labels = draft.fields.labels as string[];
  assert.equal(labels.includes("area-Team-A-Frontend"), true);
  assert.equal(labels.includes("migrated-from-ado"), true);
  // No label may contain whitespace.
  for (const l of labels) assert.equal(/\s/.test(l), false, `label "${l}" contains whitespace`);
});

Deno.test("story points come from StoryPoints, falling back to Effort", () => {
  const ctx = makeCtx();
  const a = buildIssueDraft(workItem({ "Microsoft.VSTS.Scheduling.StoryPoints": 5 }), [], ctx);
  assert.equal(a.fields.customfield_10016, 5);

  const b = buildIssueDraft(workItem({ "Microsoft.VSTS.Scheduling.Effort": 8 }), [], ctx);
  assert.equal(b.fields.customfield_10016, 8);
});

Deno.test("fields absent from createmeta are dropped", () => {
  const ctx = makeCtx(makeConfig(), { allowedFields: () => new Set(["project", "issuetype", "summary"]) });
  const draft = buildIssueDraft(
    workItem({ "Microsoft.VSTS.Scheduling.StoryPoints": 5, "System.Tags": "abc" }),
    [],
    ctx,
  );
  assert.equal(draft.fields.customfield_10016, undefined);
  assert.equal(draft.fields.labels, undefined);
  assert.equal(draft.fields.description, undefined);
});

Deno.test("rank prefers StackRank, then BacklogPriority, then the id", () => {
  const ctx = makeCtx();
  assert.equal(buildIssueDraft(workItem({ "Microsoft.VSTS.Common.StackRank": 12.5 }), [], ctx).rank, 12.5);
  assert.equal(
    buildIssueDraft(workItem({ "Microsoft.VSTS.Common.BacklogPriority": 900 }), [], ctx).rank,
    900,
  );
  assert.equal(buildIssueDraft(workItem({}, 77), [], ctx).rank, 77);
});

Deno.test("duedate is normalised to yyyy-MM-dd", () => {
  const draft = buildIssueDraft(
    workItem({ "Microsoft.VSTS.Scheduling.TargetDate": "2024-06-15T09:30:00Z" }),
    [],
    makeCtx(),
  );
  assert.equal(draft.fields.duedate, "2024-06-15");
});

Deno.test("description carries the traceability panel and unmapped fields", () => {
  const draft = buildIssueDraft(
    workItem({
      "System.Description": "<p>Description</p>",
      "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>AC1</li></ul>",
      "Microsoft.VSTS.Scheduling.RemainingWork": 6,
    }),
    [],
    makeCtx(),
  );
  const json = JSON.stringify(draft.fields.description);
  assert.equal(json.includes("Migrated from Azure DevOps"), true);
  assert.equal(json.includes("_workitems/edit/42"), true);
  assert.equal(json.includes("Acceptance Criteria"), true);
  assert.equal(json.includes("Remaining work"), true);
  assert.equal(json.includes("6h"), true);
});

Deno.test("the parent id is recorded for the hierarchy phase", () => {
  const draft = buildIssueDraft(workItem({ "System.Parent": 7 }), [], makeCtx());
  assert.equal(draft.parentAdoId, 7);
  assert.equal(draft.fields.parent, undefined, "parent must not be set at creation time");
});

Deno.test("sanitizeLabel keeps Unicode and only strips whitespace", () => {
  // Jira labels accept Unicode, so accented tags must survive intact — an
  // earlier version stripped them down to bare ASCII.
  assert.equal(sanitizeLabel("Grüße Welt"), "Grüße-Welt");
  assert.equal(sanitizeLabel("naïve"), "naïve");
  assert.equal(sanitizeLabel("tech-debt"), "tech-debt");
  assert.equal(sanitizeLabel("a/b:c.d"), "a/b:c.d");
  assert.equal(sanitizeLabel("  lots   of  spaces "), "lots-of-spaces");
  assert.equal(sanitizeLabel("-leading-trailing-"), "leading-trailing");
});

Deno.test("history collapses into a table, skipping revisions with no real change", () => {
  const updates: AdoUpdate[] = [
    { id: 1, rev: 1, revisedDate: "2024-01-01T00:00:00Z", revisedBy: { displayName: "An" }, fields: {} },
    {
      id: 2,
      rev: 2,
      revisedDate: "2024-01-02T00:00:00Z",
      revisedBy: { displayName: "Binh" },
      fields: {
        "System.State": { oldValue: "New", newValue: "Active" },
        "System.Rev": { oldValue: 1, newValue: 2 },
      },
    },
  ];
  const doc = buildHistoryComment(updates, workItem({}));
  assert.notEqual(doc, null);
  const json = JSON.stringify(doc);
  assert.equal(json.includes("State: New → Active"), true);
  assert.equal(json.includes("System.Rev"), false, "internal fields must not appear");

  const table = doc!.content.find((n) => n.type === "table")!;
  // One header row plus one row with a real change; the empty revision is dropped.
  assert.equal(table.content?.length, 2);
});

Deno.test("empty history returns null", () => {
  assert.equal(buildHistoryComment([], workItem({})), null);
  assert.equal(buildHistoryComment([{ id: 1, rev: 1, fields: {} }], workItem({})), null);
});
