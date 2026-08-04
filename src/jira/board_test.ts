import assert from "node:assert/strict";
import { join } from "node:path";
import { Importer, PHASES } from "./import.ts";
import { Store } from "../util/state.ts";
import { makeConfig } from "../testing/fixtures.ts";
import { DataLayout } from "../ado/export.ts";
import { setVerbose } from "../log.ts";
import type { ExportManifest } from "../ado/types.ts";

setVerbose(false);

type BoardType = "scrum" | "kanban" | "simple";

/**
 * A minimal fake Jira, just enough to reach the sprints phase. The test picks
 * the board type returned, which is exactly what differs between a
 * company-managed Scrum project (`scrum`), team-managed (`simple`) and Kanban.
 */
function startJira(boards: { id: number; name: string; type: BoardType }[]) {
  const sprintsCreated: { id: number; name: string; originBoardId: number }[] = [];
  const sprintMembers: Record<number, string[]> = {};
  let seq = 9000;

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const p = new URL(req.url).pathname;
    const m = req.method;

    if (p === "/rest/api/2/serverInfo") return json({ deploymentType: "Cloud", version: "1001.0.0" });
    if (p === "/rest/api/3/myself") return json({ accountId: "me", displayName: "T", active: true });
    if (p === "/rest/api/3/project/WEB") {
      return json({
        id: "1",
        key: "WEB",
        name: "Web",
        issueTypes: [{ id: "3", name: "Task", subtask: false, hierarchyLevel: 0 }],
      });
    }
    if (/createmeta/.test(p)) {
      return json({ fields: ["project", "issuetype", "summary"].map((fieldId) => ({ fieldId })) });
    }
    if (p === "/rest/api/3/project/WEB/components") return json([]);
    if (p === "/rest/api/3/project/WEB/statuses") {
      return json([{ statuses: [{ id: "1", name: "To Do" }] }]);
    }
    if (p === "/rest/api/3/issueLinkType") return json({ issueLinkTypes: [] });
    if (p === "/rest/api/3/field") return json([]);
    if (p === "/rest/api/3/user/search") return json([]);

    if (p === "/rest/agile/1.0/board") return json({ isLast: true, values: boards });
    if (/^\/rest\/agile\/1\.0\/board\/\d+\/sprint$/.test(p)) return json({ isLast: true, values: [] });
    if (p === "/rest/agile/1.0/sprint" && m === "POST") {
      const b = await req.json() as { name: string; originBoardId: number };
      const s = { id: ++seq, name: b.name, originBoardId: b.originBoardId };
      sprintsCreated.push(s);
      return json(s, 201);
    }
    const sm = /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/.exec(p);
    if (sm && m === "POST") {
      const b = await req.json() as { issues: string[] };
      (sprintMembers[Number(sm[1])] ??= []).push(...b.issues);
      return new Response(null, { status: 204 });
    }
    if (/^\/rest\/agile\/1\.0\/sprint\/\d+$/.test(p)) return new Response(null, { status: 204 });
    if (p === "/rest/agile/1.0/issue/rank") return new Response(null, { status: 204 });

    if (p === "/rest/api/3/issue" && m === "POST") {
      const key = `WEB-${++seq - 9000}`;
      return json({ id: String(seq), key, self: "" }, 201);
    }
    if (/^\/rest\/api\/3\/issue\/WEB-\d+\/transitions$/.test(p)) return json({ transitions: [] });
    if (/^\/rest\/api\/3\/issue\/WEB-\d+$/.test(p)) {
      return json({ id: "1", key: "WEB-1", fields: { status: { name: "To Do" } } });
    }
    return json({ errorMessages: [`no mock ${m} ${p}`] }, 404);
  });

  return {
    server,
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    sprintsCreated,
    sprintMembers,
  };
}

/** Build a minimal .data: one work item inside Sprint 1. */
async function seedData(dir: string) {
  const layout = new DataLayout(dir);
  await Deno.mkdir(join(dir, "workitems", "0"), { recursive: true });
  await Deno.writeTextFile(
    layout.workItem(1),
    JSON.stringify({
      workItem: {
        id: 1,
        rev: 1,
        url: "",
        fields: {
          "System.Id": 1,
          "System.WorkItemType": "Task",
          "System.Title": "A",
          "System.State": "New",
          "System.IterationPath": "P\\Sprint 1",
        },
      },
      comments: [],
      updates: [],
      attachments: [],
    }),
  );
  await Deno.writeTextFile(
    layout.iterations,
    JSON.stringify([{
      path: "P\\Sprint 1",
      name: "Sprint 1",
      startDate: null,
      finishDate: null,
      timeFrame: "future",
      depth: 1,
      isLeaf: true,
    }]),
  );
  const manifest: ExportManifest = {
    exportedAt: new Date().toISOString(),
    org: "o",
    project: "P",
    projectId: "p",
    workItemCount: 1,
    workItemIds: [1],
    typeCounts: { Task: 1 },
    stateCounts: { New: 1 },
    iterationCount: 1,
    attachmentCount: 0,
    commentCount: 0,
  };
  await Deno.writeTextFile(layout.manifest, JSON.stringify(manifest));
}

async function runWithBoards(boards: { id: number; name: string; type: BoardType }[], boardName = "") {
  const jira = startJira(boards);
  const tmp = await Deno.makeTempDir({ prefix: "board-" });
  await seedData(join(tmp, "data"));

  const cfg = makeConfig({ dataDir: join(tmp, "data"), stateDir: join(tmp, "state") });
  cfg.jira.baseUrl = jira.base;
  cfg.jira.boardName = boardName || null;
  cfg.mapping.issueType = { Task: "Task", _default: "Task" };
  cfg.mapping.status = { _default: "To Do" };

  const store = await Store.open(cfg.stateDir, cfg.jira.projectKey);
  await new Importer(cfg, store, { dryRun: false, phases: [...PHASES] }).run();
  await store.close();
  await jira.server.shutdown();
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
  return jira;
}

Deno.test("a 'scrum' board (company-managed) can create sprints", async () => {
  const r = await runWithBoards([{ id: 1, name: "WEB Sprint board", type: "scrum" }]);
  assert.equal(r.sprintsCreated.length, 1);
  assert.equal(r.sprintsCreated[0].name, "Sprint 1");
  assert.equal(r.sprintsCreated[0].originBoardId, 1);
});

Deno.test("a 'simple' board (team-managed) can also create sprints", async () => {
  // The Jira UI only shows "Agile board"; the API returns "simple" for a
  // team-managed project. The tool used to filter this out and skip all sprints.
  const r = await runWithBoards([{ id: 2, name: "WEB board", type: "simple" }]);
  assert.equal(r.sprintsCreated.length, 1, "a team-managed board must be usable");
  assert.equal(r.sprintsCreated[0].originBoardId, 2);
  assert.equal(Object.values(r.sprintMembers).flat().length, 1, "the issue must be added to the sprint");
});

Deno.test("a kanban-only project skips sprints without failing", async () => {
  const r = await runWithBoards([{ id: 3, name: "WEB Kanban", type: "kanban" }]);
  assert.equal(r.sprintsCreated.length, 0);
});

Deno.test("with both kanban and scrum, the sprint-capable board wins", async () => {
  const r = await runWithBoards([
    { id: 4, name: "Kanban first", type: "kanban" },
    { id: 5, name: "Scrum second", type: "scrum" },
  ]);
  assert.equal(r.sprintsCreated.length, 1);
  assert.equal(r.sprintsCreated[0].originBoardId, 5, "Kanban must be skipped");
});

Deno.test("JIRA_BOARD_NAME selects the right board when several exist", async () => {
  const r = await runWithBoards([
    { id: 6, name: "Board A", type: "scrum" },
    { id: 7, name: "Board B", type: "simple" },
  ], "Board B");
  assert.equal(r.sprintsCreated[0].originBoardId, 7);
});

Deno.test("a wrong board name skips sprints rather than using another board", async () => {
  const r = await runWithBoards([{ id: 8, name: "Board A", type: "scrum" }], "Does Not Exist");
  assert.equal(r.sprintsCreated.length, 0);
});
