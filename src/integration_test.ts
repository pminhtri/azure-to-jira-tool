/**
 * End-to-end test: stand up mock servers for both Azure DevOps and Jira Cloud,
 * then run the full export -> import -> verify loop. No real system is touched.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { runExport } from "./ado/export.ts";
import { Importer, PHASES } from "./jira/import.ts";
import { Store } from "./util/state.ts";
import { setVerbose } from "./log.ts";

/* -- Fake ADO data -------------------------------------------------------- */

const ATT_GUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const IMG_GUID = "9f8fad5b-d9cb-469f-a165-70867728950f";

function adoWorkItems(base: string) {
  const attUrl = (guid: string, name: string) => `${base}/_apis/wit/attachments/${guid}?fileName=${name}`;
  return [
    {
      id: 1,
      rev: 4,
      url: `${base}/_apis/wit/workItems/1`,
      fields: {
        "System.Id": 1,
        "System.WorkItemType": "Epic",
        "System.Title": "Payments platform",
        "System.State": "Active",
        "System.AreaPath": "Contoso\\Payments",
        "System.IterationPath": "Contoso\\Release 1",
        "System.CreatedBy": { displayName: "An Nguyen", uniqueName: "an@contoso.com" },
        "System.CreatedDate": "2024-01-02T03:04:05Z",
        "System.Description": "<p>A <strong>large</strong> epic</p>",
        "Microsoft.VSTS.Common.StackRank": 100,
      },
    },
    {
      id: 2,
      rev: 7,
      url: `${base}/_apis/wit/workItems/2`,
      fields: {
        "System.Id": 2,
        "System.WorkItemType": "User Story",
        "System.Title": "Card payments",
        "System.State": "Closed",
        "System.Parent": 1,
        "System.AreaPath": "Contoso\\Payments\\Card",
        "System.IterationPath": "Contoso\\Release 1\\Sprint 1",
        "System.Tags": "urgent; payment",
        "System.AssignedTo": { displayName: "An Nguyen", uniqueName: "an@contoso.com" },
        "System.CreatedBy": { displayName: "An Nguyen", uniqueName: "an@contoso.com" },
        "System.Description": `<div>Description with an image <img src="${
          attUrl(IMG_GUID, "diagram.png")
        }"></div><ul><li>bullet</li></ul>`,
        "Microsoft.VSTS.Common.AcceptanceCriteria": "<ol><li>AC one</li></ol>",
        "Microsoft.VSTS.Scheduling.StoryPoints": 5,
        "Microsoft.VSTS.Common.Priority": 1,
        "Microsoft.VSTS.Common.StackRank": 50,
        "Microsoft.VSTS.Scheduling.RemainingWork": 3,
      },
      relations: [
        {
          rel: "AttachedFile",
          url: `${base}/_apis/wit/attachments/${ATT_GUID}`,
          attributes: { name: "spec.txt", resourceSize: 11 },
        },
        { rel: "System.LinkTypes.Related", url: `${base}/_apis/wit/workItems/3` },
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${base}/_apis/wit/workItems/1` },
      ],
    },
    {
      id: 3,
      rev: 2,
      url: `${base}/_apis/wit/workItems/3`,
      fields: {
        "System.Id": 3,
        "System.WorkItemType": "Bug",
        "System.Title": "Rounding error in totals",
        "System.State": "New",
        "System.IterationPath": "Contoso\\Release 1\\Sprint 2",
        "System.AreaPath": "Contoso\\Payments",
        "Microsoft.VSTS.TCM.ReproSteps": "<p>Step 1</p>",
        "Microsoft.VSTS.Common.StackRank": 10,
      },
      relations: [{ rel: "System.LinkTypes.Related", url: `${base}/_apis/wit/workItems/2` }],
    },
    {
      // A Task under a Story is not allowed by the Jira hierarchy and must become a link.
      id: 4,
      rev: 1,
      url: `${base}/_apis/wit/workItems/4`,
      fields: {
        "System.Id": 4,
        "System.WorkItemType": "Task",
        "System.Title": "Write unit tests",
        "System.State": "New",
        "System.Parent": 2,
        "System.AreaPath": "Contoso",
        "Microsoft.VSTS.Common.StackRank": 200,
      },
    },
  ];
}

const ITERATION_TREE = {
  id: 1,
  identifier: "root",
  name: "Contoso",
  structureType: "iteration",
  hasChildren: true,
  path: "\\Contoso\\Iteration",
  children: [
    {
      id: 2,
      identifier: "r1",
      name: "Release 1",
      structureType: "iteration",
      hasChildren: true,
      path: "\\Contoso\\Iteration\\Release 1",
      children: [
        {
          id: 3,
          identifier: "s1",
          name: "Sprint 1",
          structureType: "iteration",
          hasChildren: false,
          path: "\\Contoso\\Iteration\\Release 1\\Sprint 1",
          attributes: { startDate: "2024-01-01T00:00:00Z", finishDate: "2024-01-14T00:00:00Z" },
        },
        {
          id: 4,
          identifier: "s2",
          name: "Sprint 2",
          structureType: "iteration",
          hasChildren: false,
          path: "\\Contoso\\Iteration\\Release 1\\Sprint 2",
          attributes: { startDate: "2099-01-01T00:00:00Z", finishDate: "2099-01-14T00:00:00Z" },
        },
      ],
    },
  ],
};

/* -- Fake Jira state ------------------------------------------------------ */

interface FakeJira {
  issues: Map<string, { id: string; key: string; fields: Record<string, unknown>; status: string }>;
  links: { type: string; inward: string; outward: string }[];
  comments: Record<string, unknown[]>;
  attachments: { issueKey: string; fileName: string; size: number }[];
  sprints: { id: number; name: string; state: string; startDate?: string; endDate?: string }[];
  sprintMembers: Record<number, string[]>;
  ranked: string[];
  transitionCalls: { key: string; to: string }[];
  /** Issues where the client attempted a parent Jira rejected on hierarchy grounds. */
  rejectedParentAttempts: string[];
}

function newFakeJira(): FakeJira {
  return {
    issues: new Map(),
    links: [],
    comments: {},
    attachments: [],
    sprints: [],
    sprintMembers: {},
    ranked: [],
    transitionCalls: [],
    rejectedParentAttempts: [],
  };
}

const WORKFLOW: Record<string, string[]> = {
  "To Do": ["In Progress"],
  "In Progress": ["To Do", "Done"],
  "Done": ["To Do"],
};

function startServer(state: FakeJira) {
  let issueSeq = 10000;
  let sprintSeq = 500;
  let base = "";

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    /* ─── Azure DevOps ─────────────────────────────────────────────── */

    if (path === "/ado/_apis/projects/Contoso") return json({ id: "proj-1", name: "Contoso" });

    if (path === "/ado/Contoso/_apis/wit/wiql" && method === "POST") {
      const body = await req.json() as { query: string };
      const after = Number(/\[System\.Id\] > (\d+)/.exec(body.query)?.[1] ?? 0);
      const ids = [1, 2, 3, 4].filter((i) => i > after);
      return json({ workItems: ids.map((id) => ({ id })) });
    }

    if (path === "/ado/_apis/wit/workitemsbatch" && method === "POST") {
      const body = await req.json() as { ids: number[] };
      const all = adoWorkItems(`${base}/ado`);
      const value = body.ids.map((id) => all.find((w) => w.id === id)).filter(Boolean);
      return json({ count: value.length, value });
    }

    const commentsMatch = /^\/ado\/Contoso\/_apis\/wit\/workItems\/(\d+)\/comments$/.exec(path);
    if (commentsMatch) {
      const id = Number(commentsMatch[1]);
      const comments = id === 2
        ? [{
          id: 90,
          workItemId: 2,
          version: 1,
          text: "<p>Reviewed, <em>looks good</em></p>",
          createdBy: { displayName: "An Nguyen", uniqueName: "an@contoso.com" },
          createdDate: "2024-02-01T00:00:00Z",
        }]
        : [];
      return json({ comments });
    }

    const updatesMatch = /^\/ado\/Contoso\/_apis\/wit\/workItems\/(\d+)\/updates$/.exec(path);
    if (updatesMatch) {
      const id = Number(updatesMatch[1]);
      const value = id === 2
        ? [{
          id: 1,
          rev: 2,
          revisedDate: "2024-01-20T00:00:00Z",
          revisedBy: { displayName: "An Nguyen" },
          fields: { "System.State": { oldValue: "New", newValue: "Active" } },
        }]
        : [];
      return json({ count: value.length, value });
    }

    if (path === "/ado/Contoso/_apis/wit/classificationnodes/iterations") return json(ITERATION_TREE);
    if (path === "/ado/Contoso/_apis/wit/classificationnodes/areas") {
      return json({
        id: 9,
        identifier: "a",
        name: "Contoso",
        structureType: "area",
        hasChildren: false,
        path: "\\Contoso\\Area",
      });
    }
    if (path === "/ado/_apis/projects/Contoso/teams") {
      return json({ count: 1, value: [{ id: "team-1", name: "Contoso Team" }] });
    }
    if (path === "/ado/Contoso/team-1/_apis/work/teamsettings/iterations") {
      return json({ count: 0, value: [] });
    }

    const attMatch = /^\/ado\/_apis\/wit\/attachments\/([0-9a-fA-F-]{36})$/.exec(path);
    if (attMatch) {
      const body = attMatch[1] === IMG_GUID ? "PNGDATA" : "spec noi dung";
      return new Response(body, { headers: { "content-type": "application/octet-stream" } });
    }

    /* ─── Jira Cloud ───────────────────────────────────────────────── */

    // Real Jira Cloud also serves this v2 endpoint; the client uses it to tell
    // Cloud and Server apart.
    if (path === "/jira/rest/api/2/serverInfo") {
      return json({ deploymentType: "Cloud", version: "1001.0.0" });
    }

    if (path === "/jira/rest/api/3/myself") {
      return json({ accountId: "me", displayName: "Migrator", emailAddress: "m@contoso.com", active: true });
    }

    if (path === "/jira/rest/api/3/project/WEB") {
      return json({
        id: "1",
        key: "WEB",
        name: "Web",
        style: "classic",
        issueTypes: [
          { id: "1", name: "Epic", subtask: false, hierarchyLevel: 1 },
          { id: "2", name: "Story", subtask: false, hierarchyLevel: 0 },
          { id: "3", name: "Task", subtask: false, hierarchyLevel: 0 },
          { id: "4", name: "Bug", subtask: false, hierarchyLevel: 0 },
        ],
      });
    }

    if (/^\/jira\/rest\/api\/3\/issue\/createmeta\/WEB\/issuetypes\/\d+$/.test(path)) {
      return json({
        fields: [
          "project",
          "issuetype",
          "summary",
          "description",
          "assignee",
          "priority",
          "labels",
          "duedate",
          "parent",
          "customfield_10016",
        ].map((fieldId) => ({ fieldId })),
      });
    }

    if (path === "/jira/rest/api/3/project/WEB/components") return json([]);

    if (path === "/jira/rest/api/3/project/WEB/statuses") {
      return json([{
        statuses: [
          { id: "1", name: "To Do" },
          { id: "2", name: "In Progress" },
          { id: "3", name: "Done" },
        ],
      }]);
    }

    if (path === "/jira/rest/api/3/issueLinkType") {
      return json({
        issueLinkTypes: [
          { id: "1", name: "Relates", inward: "relates to", outward: "relates to" },
          { id: "2", name: "Blocks", inward: "is blocked by", outward: "blocks" },
        ],
      });
    }

    if (path === "/jira/rest/api/3/field") {
      return json([
        {
          id: "customfield_10016",
          key: "cf",
          name: "Story Points",
          custom: true,
          schema: { type: "number" },
        },
      ]);
    }

    if (path === "/jira/rest/api/3/user/search") {
      const query = url.searchParams.get("query") ?? "";
      if (query === "an@contoso.com") {
        return json([{ accountId: "acc-an", displayName: "An Nguyen", emailAddress: query, active: true }]);
      }
      return json([]);
    }

    if (path === "/jira/rest/api/3/issue" && method === "POST") {
      const body = await req.json() as { fields: Record<string, unknown> };
      // Mimic Jira: reject any field missing from createmeta.
      if ("customfield_99999" in body.fields) {
        return json({ errors: { customfield_99999: "Field does not exist" } }, 400);
      }
      const id = String(++issueSeq);
      const key = `WEB-${issueSeq - 10000}`;
      state.issues.set(key, { id, key, fields: body.fields, status: "To Do" });
      return json({ id, key, self: `${base}/jira/rest/api/3/issue/${id}` }, 201);
    }

    const issueMatch = /^\/jira\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(path);
    if (issueMatch) {
      const issue = state.issues.get(issueMatch[1]);
      if (!issue) return json({ errorMessages: ["Issue does not exist"] }, 404);
      if (method === "PUT") {
        const body = await req.json() as { fields: Record<string, unknown> };
        // Jira blocks parent when the hierarchy level is invalid.
        const parentKey = (body.fields.parent as { key?: string } | undefined)?.key;
        if (parentKey) {
          const parent = state.issues.get(parentKey);
          const parentType = (parent?.fields.issuetype as { name?: string } | undefined)?.name;
          if (parentType !== "Epic") {
            state.rejectedParentAttempts.push(issue.key);
            return json({ errors: { parent: "Invalid hierarchy" } }, 400);
          }
        }
        Object.assign(issue.fields, body.fields);
        return new Response(null, { status: 204 });
      }
      return json({
        id: issue.id,
        key: issue.key,
        fields: { ...issue.fields, status: { name: issue.status } },
      });
    }

    const commentMatch = /^\/jira\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(path);
    if (commentMatch && method === "POST") {
      const body = await req.json();
      (state.comments[commentMatch[1]] ??= []).push(body);
      return json({ id: "c1" }, 201);
    }

    const attachMatch = /^\/jira\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/attachments$/.exec(path);
    if (attachMatch && method === "POST") {
      assert.equal(req.headers.get("x-atlassian-token"), "no-check");
      const form = await req.formData();
      const file = form.get("file") as File;
      state.attachments.push({ issueKey: attachMatch[1], fileName: file.name, size: file.size });
      return json([{ id: `att-${state.attachments.length}` }], 200);
    }

    if (path === "/jira/rest/api/3/issueLink" && method === "POST") {
      const body = await req.json() as {
        type: { name: string };
        inwardIssue: { key: string };
        outwardIssue: { key: string };
      };
      state.links.push({
        type: body.type.name,
        inward: body.inwardIssue.key,
        outward: body.outwardIssue.key,
      });
      return new Response(null, { status: 201 });
    }

    const transMatch = /^\/jira\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/transitions$/.exec(path);
    if (transMatch) {
      const issue = state.issues.get(transMatch[1])!;
      if (method === "GET") {
        const targets = WORKFLOW[issue.status] ?? [];
        return json({
          transitions: targets.map((name, i) => ({
            id: String(i + 1),
            name: `To ${name}`,
            to: { id: name, name },
          })),
        });
      }
      const body = await req.json() as { transition: { id: string } };
      const targets = WORKFLOW[issue.status] ?? [];
      const next = targets[Number(body.transition.id) - 1];
      issue.status = next;
      state.transitionCalls.push({ key: issue.key, to: next });
      return new Response(null, { status: 204 });
    }

    if (path === "/jira/rest/agile/1.0/board") {
      return json({ isLast: true, values: [{ id: 7, name: "WEB board", type: "scrum" }] });
    }

    if (path === "/jira/rest/agile/1.0/board/7/sprint") {
      return json({ isLast: true, values: state.sprints });
    }

    if (path === "/jira/rest/agile/1.0/sprint" && method === "POST") {
      const body = await req.json() as { name: string; startDate?: string; endDate?: string };
      const sprint = { ...body, id: ++sprintSeq, state: "future" };
      state.sprints.push(sprint);
      return json(sprint, 201);
    }

    const sprintIssueMatch = /^\/jira\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/.exec(path);
    if (sprintIssueMatch && method === "POST") {
      const body = await req.json() as { issues: string[] };
      const id = Number(sprintIssueMatch[1]);
      (state.sprintMembers[id] ??= []).push(...body.issues);
      return new Response(null, { status: 204 });
    }

    const sprintMatch = /^\/jira\/rest\/agile\/1\.0\/sprint\/(\d+)$/.exec(path);
    if (sprintMatch && method === "POST") {
      const body = await req.json() as { state?: string };
      const sprint = state.sprints.find((s) => s.id === Number(sprintMatch[1]));
      if (sprint && body.state) sprint.state = body.state;
      return new Response(null, { status: 204 });
    }

    if (path === "/jira/rest/agile/1.0/issue/rank" && method === "PUT") {
      const body = await req.json() as { issues: string[]; rankAfterIssue: string };
      state.ranked.push(body.rankAfterIssue, ...body.issues);
      return new Response(null, { status: 204 });
    }

    return json({ errorMessages: [`No mock route: ${method} ${path}`] }, 404);
  };

  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  base = `http://localhost:${(server.addr as Deno.NetAddr).port}`;
  return { server, base: () => base };
}

/* ── Test ────────────────────────────────────────────────────────────────── */

Deno.test("migrate end-to-end: export ADO → import Jira", async (t) => {
  setVerbose(false);
  const fake = newFakeJira();
  const { server, base } = startServer(fake);
  const tmp = await Deno.makeTempDir({ prefix: "ado2jira-" });

  const env: Record<string, string> = {
    ADO_ORG: "contoso",
    ADO_PROJECT: "Contoso",
    ADO_PAT: "fake-pat",
    ADO_BASE_URL: `${base()}/ado`,
    JIRA_BASE_URL: `${base()}/jira`,
    JIRA_EMAIL: "m@contoso.com",
    JIRA_API_TOKEN: "fake-token",
    JIRA_PROJECT_KEY: "WEB",
    JIRA_BOARD_NAME: "",
    CONCURRENCY: "2",
    DATA_DIR: join(tmp, "data"),
    STATE_DIR: join(tmp, "state"),
  };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);

  const configPath = join(tmp, "config.json");
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      options: { inlineImageMode: "link", closeCompletedSprints: true },
      issueType: { Epic: "Epic", "User Story": "Story", Bug: "Bug", _default: "Task" },
      status: { New: "To Do", Active: "In Progress", Closed: "Done", _default: "To Do" },
      priority: { "1": "Highest", _default: "Medium" },
      linkType: { "System.LinkTypes.Related": { name: "Relates", direction: "outward" } },
      fields: { storyPoints: "customfield_10016" },
      labels: { fromTags: true, fromAreaPath: true, areaPathPrefix: "area-", extra: ["migrated-from-ado"] },
      users: { autoLookup: true, map: {} },
    }),
  );

  try {
    const cfg = await loadConfig(configPath);

    await t.step("export pulls every work item, comment, attachment and iteration", async () => {
      const manifest = await runExport(cfg, { resume: false });
      assert.equal(manifest.workItemCount, 4);
      assert.deepEqual(manifest.workItemIds, [1, 2, 3, 4]);
      assert.deepEqual(manifest.typeCounts, { "Epic": 1, "User Story": 1, "Bug": 1, "Task": 1 });
      assert.equal(manifest.commentCount, 1);
      // One attached file plus one image embedded in the description.
      assert.equal(manifest.attachmentCount, 2);
      assert.equal(manifest.iterationCount, 3);

      const spec = await Deno.readTextFile(
        join(cfg.dataDir, "attachments", "2", `${ATT_GUID.slice(0, 8)}-spec.txt`),
      );
      assert.equal(spec, "spec noi dung");
    });

    await t.step("a second export with resume re-downloads nothing", async () => {
      const manifest = await runExport(cfg, { resume: true });
      assert.equal(manifest.workItemCount, 4);
      assert.equal(manifest.commentCount, 1);
    });

    const store = await Store.open(cfg.stateDir, "WEB");

    await t.step("dry-run writes nothing to Jira", async () => {
      const dry = new Importer(cfg, store, { dryRun: true, phases: [...PHASES] });
      await dry.run();
      assert.equal(fake.issues.size, 0);
      assert.equal(fake.sprints.length, 0);
    });

    await t.step("import creates issues with correctly mapped fields", async () => {
      const importer = new Importer(cfg, store, { dryRun: false, phases: [...PHASES] });
      await importer.run();

      assert.equal(fake.issues.size, 4, "exactly 4 issues must be created");

      const epicKey = store.issue(1)!.key;
      const storyKey = store.issue(2)!.key;
      const bugKey = store.issue(3)!.key;

      const epic = fake.issues.get(epicKey)!;
      assert.deepEqual(epic.fields.issuetype, { name: "Epic" });
      assert.equal(epic.fields.summary, "Payments platform");

      const story = fake.issues.get(storyKey)!;
      assert.deepEqual(story.fields.issuetype, { name: "Story" });
      assert.deepEqual(story.fields.assignee, { id: "acc-an" });
      assert.deepEqual(story.fields.priority, { name: "Highest" });
      assert.equal(story.fields.customfield_10016, 5);

      const labels = story.fields.labels as string[];
      assert.equal(labels.includes("urgent"), true, "tags become labels");
      assert.equal(labels.includes("payment"), true);
      assert.equal(labels.includes("area-Payments-Card"), true);

      const desc = JSON.stringify(story.fields.description);
      assert.equal(desc.includes("Migrated from Azure DevOps"), true);
      assert.equal(desc.includes("Acceptance Criteria"), true);
      assert.equal(desc.includes("Remaining work"), true);

      const bug = fake.issues.get(bugKey)!;
      assert.equal(JSON.stringify(bug.fields.description).includes("Repro Steps"), true);
    });

    await t.step("hierarchy: valid parents are set, invalid ones fall back to a link", () => {
      const epicKey = store.issue(1)!.key;
      const storyKey = store.issue(2)!.key;
      const taskKey = store.issue(4)!.key;

      const story = fake.issues.get(storyKey)!;
      assert.deepEqual(story.fields.parent, { key: epicKey }, "a Story under an Epic must get a parent");
      assert.equal(store.issue(2)!.parentDone, true);

      // A Task under a Story cannot nest in Jira, so the relation must survive as
      // a link — and no doomed parent request may be sent.
      const task = fake.issues.get(taskKey)!;
      assert.equal(task.fields.parent, undefined);
      assert.equal(store.issue(4)!.parentDone, true, "still marked done so it is not retried");
      const demoted = fake.links.find((l) => l.inward === taskKey && l.outward === storyKey);
      assert.notEqual(demoted, undefined, "the parent-child relation must survive as a Relates link");
      assert.equal(demoted!.type, "Relates");
      assert.equal(
        fake.rejectedParentAttempts.includes(taskKey),
        false,
        "a known-invalid hierarchy must not trigger a parent request",
      );
    });

    await t.step("a bidirectional link is created only once", () => {
      const storyKey = store.issue(2)!.key;
      const bugKey = store.issue(3)!.key;
      const relates = fake.links.filter((l) => l.type === "Relates");
      const between = relates.filter((l) =>
        (l.inward === storyKey && l.outward === bugKey) || (l.inward === bugKey && l.outward === storyKey)
      );
      assert.equal(between.length, 1, `bidirectional links must dedupe, got ${JSON.stringify(relates)}`);
    });

    await t.step("attachments upload and inline images become Jira links", () => {
      const storyKey = store.issue(2)!.key;
      assert.equal(fake.attachments.length, 2);
      assert.deepEqual(fake.attachments.map((a) => a.fileName).sort(), ["diagram.png", "spec.txt"]);
      assert.equal(fake.attachments.every((a) => a.issueKey === storyKey), true);

      // The description must be re-rendered with links to the Jira attachments.
      const desc = JSON.stringify(fake.issues.get(storyKey)!.fields.description);
      assert.equal(desc.includes("/rest/api/3/attachment/content/"), true);
      assert.equal(desc.includes("diagram.png"), true);
    });

    await t.step("both comments and history are written", () => {
      const storyKey = store.issue(2)!.key;
      const comments = fake.comments[storyKey] ?? [];
      assert.equal(comments.length, 2, "one original comment plus one history summary");
      const all = JSON.stringify(comments);
      assert.equal(all.includes("Reviewed"), true);
      assert.equal(all.includes("An Nguyen"), true);
      assert.equal(all.includes("State: New → Active"), true);
    });

    await t.step("sprints come from the iterations in use and get the right issues", () => {
      // Only 3 iterations are referenced: Release 1, Sprint 1, Sprint 2.
      assert.equal(fake.sprints.length, 3);
      const names = fake.sprints.map((s) => s.name).sort();
      assert.deepEqual(names, ["Release 1", "Release 1 / Sprint 1", "Release 1 / Sprint 2"]);

      const sprint1 = fake.sprints.find((s) => s.name === "Release 1 / Sprint 1")!;
      assert.equal(sprint1.startDate, "2024-01-01T00:00:00Z");
      assert.deepEqual(fake.sprintMembers[sprint1.id], [store.issue(2)!.key]);

      const sprint2 = fake.sprints.find((s) => s.name === "Release 1 / Sprint 2")!;
      assert.deepEqual(fake.sprintMembers[sprint2.id], [store.issue(3)!.key]);

      // A finished sprint must be closed; a future one must not.
      assert.equal(sprint1.state, "closed");
      assert.equal(sprint2.state, "future");
    });

    await t.step("rank follows ascending StackRank", () => {
      // StackRank: bug=10, story=50, epic=100, task=200.
      assert.deepEqual(fake.ranked, [3, 2, 1, 4].map((id) => store.issue(id)!.key));
    });

    await t.step("transitions reach the target status, even across several hops", () => {
      assert.equal(fake.issues.get(store.issue(1)!.key)!.status, "In Progress");
      // Closed -> Done must pass through In Progress; no direct jump is allowed.
      assert.equal(fake.issues.get(store.issue(2)!.key)!.status, "Done");
      assert.equal(fake.issues.get(store.issue(3)!.key)!.status, "To Do");
      assert.equal(fake.issues.get(store.issue(4)!.key)!.status, "To Do");
    });

    await t.step("no failures were recorded", () => {
      assert.deepEqual(store.data.failures, [], JSON.stringify(store.data.failures, null, 2));
    });

    await t.step("re-running import is idempotent and creates no duplicates", async () => {
      const before = {
        issues: fake.issues.size,
        links: fake.links.length,
        comments: Object.values(fake.comments).flat().length,
        attachments: fake.attachments.length,
        sprints: fake.sprints.length,
      };
      const again = new Importer(cfg, store, { dryRun: false, phases: [...PHASES] });
      await again.run();

      assert.equal(fake.issues.size, before.issues, "no new issue may be created");
      assert.equal(fake.links.length, before.links, "no duplicate link may be created");
      assert.equal(Object.values(fake.comments).flat().length, before.comments, "comments must not repeat");
      assert.equal(fake.attachments.length, before.attachments, "attachments must not re-upload");
      assert.equal(fake.sprints.length, before.sprints, "no duplicate sprint may be created");
    });

    await store.close();
  } finally {
    await server.shutdown();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    for (const k of Object.keys(env)) Deno.env.delete(k);
  }
});
