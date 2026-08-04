/**
 * Importing into Jira Server / Data Center: API v2, wiki markup, Bearer auth,
 * assignee by username, and Epics linked through the Epic Link custom field.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { Importer, PHASES } from "./import.ts";
import { Store } from "../util/state.ts";
import { makeConfig } from "../testing/fixtures.ts";
import { DataLayout } from "../ado/export.ts";
import { setVerbose } from "../log.ts";
import type { ExportManifest } from "../ado/types.ts";

setVerbose(false);

const EPIC_LINK = "customfield_10014";

interface Captured {
  authHeaders: string[];
  paths: string[];
  created: { key: string; fields: Record<string, unknown> }[];
  updates: { key: string; fields: Record<string, unknown> }[];
  comments: { key: string; body: unknown }[];
  links: { inward: string; outward: string }[];
}

function startServerJira() {
  const cap: Captured = { authHeaders: [], paths: [], created: [], updates: [], comments: [], links: [] };
  let seq = 100;
  const issues = new Map<string, { key: string; type: string; subtask: boolean }>();

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const p = new URL(req.url).pathname;
    const m = req.method;
    cap.paths.push(`${m} ${p}`);
    const auth = req.headers.get("authorization");
    if (auth) cap.authHeaders.push(auth);

    // Jira Server has NO /rest/api/3 — return 404 so a wrong call shows up immediately.
    if (p.startsWith("/rest/api/3")) return json({ errorMessages: ["v3 does not exist"] }, 404);

    if (p === "/rest/api/2/serverInfo") {
      return json({ version: "9.12.5", deploymentType: "Server", serverTitle: "Sioux Jira" });
    }
    if (p === "/rest/api/2/myself") return json({ name: "jdoe", displayName: "John Doe", active: true });
    if (p === "/rest/api/2/project/WEB") {
      return json({
        id: "1",
        key: "WEB",
        name: "Web",
        issueTypes: [
          { id: "1", name: "Epic", subtask: false },
          { id: "3", name: "Task", subtask: false },
          { id: "5", name: "Sub-task", subtask: true },
        ],
      });
    }
    if (p === "/rest/api/2/issue/createmeta") {
      return json({
        projects: [{
          issuetypes: [{
            id: "3",
            fields: {
              project: {},
              issuetype: {},
              summary: {},
              description: {},
              assignee: {},
              labels: {},
              [EPIC_LINK]: {},
            },
          }],
        }],
      });
    }
    if (p === "/rest/api/2/project/WEB/components") return json([]);
    if (p === "/rest/api/2/project/WEB/statuses") return json([{ statuses: [{ id: "1", name: "To Do" }] }]);
    if (p === "/rest/api/2/issueLinkType") {
      return json({ issueLinkTypes: [{ id: "1", name: "Relates", inward: "r", outward: "r" }] });
    }
    if (p === "/rest/api/2/field") return json([{ id: EPIC_LINK, name: "Epic Link", custom: true }]);
    if (p === "/rest/api/2/user/search") {
      const q = new URL(req.url).searchParams;
      // Server takes `username`, not `query`.
      if (!q.get("username")) return json([]);
      return json([{
        name: "jdoe",
        displayName: "John Doe",
        emailAddress: q.get("username"),
        active: true,
      }]);
    }

    if (p === "/rest/api/2/issue" && m === "POST") {
      const body = await req.json() as { fields: Record<string, unknown> };
      const key = `WEB-${++seq - 100}`;
      const type = (body.fields.issuetype as { name: string }).name;
      issues.set(key, { key, type, subtask: type === "Sub-task" });
      cap.created.push({ key, fields: body.fields });
      return json({ id: String(seq), key, self: "" }, 201);
    }

    const iM = /^\/rest\/api\/2\/issue\/(WEB-\d+)$/.exec(p);
    if (iM) {
      if (m === "PUT") {
        const body = await req.json() as { fields: Record<string, unknown> };
        cap.updates.push({ key: iM[1], fields: body.fields });
        // Server only accepts `parent` for sub-tasks.
        if (body.fields.parent && !issues.get(iM[1])?.subtask) {
          return json({ errors: { parent: "only sub-tasks may have a parent" } }, 400);
        }
        return new Response(null, { status: 204 });
      }
      return json({ id: "1", key: iM[1], fields: { status: { name: "To Do" } } });
    }

    const cM = /^\/rest\/api\/2\/issue\/(WEB-\d+)\/comment$/.exec(p);
    if (cM && m === "POST") {
      const body = await req.json() as { body: unknown };
      cap.comments.push({ key: cM[1], body: body.body });
      return json({ id: "c" }, 201);
    }

    if (p === "/rest/api/2/issueLink" && m === "POST") {
      const b = await req.json() as { inwardIssue: { key: string }; outwardIssue: { key: string } };
      cap.links.push({ inward: b.inwardIssue.key, outward: b.outwardIssue.key });
      return new Response(null, { status: 201 });
    }

    if (/^\/rest\/api\/2\/issue\/WEB-\d+\/transitions$/.test(p)) return json({ transitions: [] });
    if (p === "/rest/agile/1.0/board") return json({ isLast: true, values: [] });
    if (p === "/rest/agile/1.0/issue/rank") return new Response(null, { status: 204 });

    return json({ errorMessages: [`no mock ${m} ${p}`] }, 404);
  });

  return { server, base: `http://localhost:${(server.addr as Deno.NetAddr).port}`, cap };
}

/** Epic #1 with one child Task #2 whose description is Markdown. */
async function seed(dir: string) {
  const layout = new DataLayout(dir);
  await Deno.mkdir(join(dir, "workitems", "0"), { recursive: true });

  const write = (id: number, fields: Record<string, unknown>) =>
    Deno.writeTextFile(
      layout.workItem(id),
      JSON.stringify({
        workItem: { id, rev: 1, url: "", fields: { "System.Id": id, ...fields } },
        comments: id === 2
          ? [{
            id: 1,
            workItemId: 2,
            version: 1,
            text: "Finished the **review**",
            createdBy: { displayName: "An" },
          }]
          : [],
        updates: [],
        attachments: [],
      }),
    );

  await write(1, { "System.WorkItemType": "Epic", "System.Title": "Platform", "System.State": "New" });
  await write(2, {
    "System.WorkItemType": "Task",
    "System.Title": "Payments",
    "System.State": "New",
    "System.Parent": 1,
    "System.AssignedTo": { displayName: "John Doe", uniqueName: "jdoe@contoso.com" },
    "System.Description": "## Goals\n\n- [x] done\n- [ ] todo",
  });

  await Deno.writeTextFile(layout.iterations, "[]");
  const manifest: ExportManifest = {
    exportedAt: new Date().toISOString(),
    org: "o",
    project: "P",
    projectId: "p",
    workItemCount: 2,
    workItemIds: [1, 2],
    typeCounts: { Epic: 1, Task: 1 },
    stateCounts: { New: 2 },
    iterationCount: 0,
    attachmentCount: 0,
    commentCount: 1,
  };
  await Deno.writeTextFile(layout.manifest, JSON.stringify(manifest));
}

Deno.test("import into Jira Server: v2 + wiki + Bearer + Epic Link", async (t) => {
  const jira = startServerJira();
  const tmp = await Deno.makeTempDir({ prefix: "srv-" });
  await seed(join(tmp, "data"));

  const cfg = makeConfig({ dataDir: join(tmp, "data"), stateDir: join(tmp, "state") });
  cfg.jira.baseUrl = jira.base;
  cfg.jira.email = ""; // PAT only, so Bearer must be selected
  cfg.jira.apiToken = "pat-abc";
  cfg.jira.deployment = "auto";
  cfg.jira.authScheme = "auto";
  cfg.mapping.issueType = { Epic: "Epic", Task: "Task", _default: "Task" };
  cfg.mapping.status = { _default: "To Do" };
  cfg.mapping.fields.epicLink = EPIC_LINK;
  cfg.mapping.fields.storyPoints = null;
  cfg.mapping.fields.adoId = null;

  const store = await Store.open(cfg.stateDir, cfg.jira.projectKey);
  try {
    await new Importer(cfg, store, { dryRun: false, phases: [...PHASES] }).run();

    await t.step("never calls a v3 endpoint", () => {
      const v3 = jira.cap.paths.filter((p) => p.includes("/rest/api/3"));
      assert.deepEqual(v3, [], `wrongly called v3: ${v3.join(", ")}`);
    });

    await t.step("uses Bearer auth when only a token is set", () => {
      assert.equal(jira.cap.authHeaders.length > 0, true);
      assert.equal(
        jira.cap.authHeaders.every((h) => h === "Bearer pat-abc"),
        true,
        `header sai: ${jira.cap.authHeaders[0]}`,
      );
    });

    await t.step("the description is sent as wiki markup, not ADF", () => {
      const task = jira.cap.created.find((c) => c.fields.summary === "Payments")!;
      const desc = task.fields.description;
      assert.equal(typeof desc, "string", "Server must receive a string, not an ADF object");
      const text = desc as string;
      assert.equal(text.includes("h2. Goals"), true, text);
      assert.equal(text.includes("* ☑ done"), true, text);
      assert.equal(text.includes("* ☐ todo"), true, text);
      assert.equal(text.includes('"type":"doc"'), false, "no ADF JSON may leak through");
    });

    await t.step("assignee is a username, not an accountId", () => {
      const task = jira.cap.created.find((c) => c.fields.summary === "Payments")!;
      assert.deepEqual(task.fields.assignee, { name: "jdoe" });
    });

    await t.step("comments are wiki markup too", () => {
      assert.equal(jira.cap.comments.length, 1);
      const body = jira.cap.comments[0].body;
      assert.equal(typeof body, "string");
      assert.equal((body as string).includes("*review*"), true, body as string);
    });

    await t.step("a Task under an Epic uses Epic Link, not the parent field", () => {
      const taskKey = store.issue(2)!.key;
      const epicKey = store.issue(1)!.key;

      const parentAttempts = jira.cap.updates.filter((u) => u.key === taskKey && u.fields.parent);
      assert.deepEqual(parentAttempts, [], "Server rejects parent for non-subtasks, so do not try");

      const epicUpdate = jira.cap.updates.find((u) => u.key === taskKey && u.fields[EPIC_LINK]);
      assert.notEqual(epicUpdate, undefined, "Epic Link must be set");
      assert.equal(epicUpdate!.fields[EPIC_LINK], epicKey);

      assert.deepEqual(jira.cap.links, [], "with Epic Link working, no Relates link is needed");
      assert.equal(store.issue(2)!.parentDone, true);
    });

    await t.step("no failures were recorded", () => {
      assert.deepEqual(store.data.failures, [], JSON.stringify(store.data.failures));
    });
  } finally {
    await store.close();
    await jira.server.shutdown();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("without Epic Link configured, Server falls back to a Relates link", async () => {
  const jira = startServerJira();
  const tmp = await Deno.makeTempDir({ prefix: "srv2-" });
  await seed(join(tmp, "data"));

  const cfg = makeConfig({ dataDir: join(tmp, "data"), stateDir: join(tmp, "state") });
  cfg.jira.baseUrl = jira.base;
  cfg.jira.email = "";
  cfg.jira.apiToken = "pat";
  cfg.mapping.issueType = { Epic: "Epic", Task: "Task", _default: "Task" };
  cfg.mapping.status = { _default: "To Do" };
  cfg.mapping.fields.epicLink = null; // <- the difference under test
  cfg.mapping.fields.storyPoints = null;
  cfg.mapping.fields.adoId = null;

  const store = await Store.open(cfg.stateDir, cfg.jira.projectKey);
  try {
    await new Importer(cfg, store, { dryRun: false, phases: [...PHASES] }).run();
    assert.equal(jira.cap.links.length, 1, "the relation must survive as a Relates link");
    assert.equal(jira.cap.links[0].inward, store.issue(2)!.key);
    assert.equal(jira.cap.links[0].outward, store.issue(1)!.key);
    assert.deepEqual(store.data.failures, []);
  } finally {
    await store.close();
    await jira.server.shutdown();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});
