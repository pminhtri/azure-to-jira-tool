import assert from "node:assert/strict";
import { AdoClient } from "./client.ts";
import { makeConfig } from "../testing/fixtures.ts";

const QUERY_GUID = "642616e5-7a1d-42ba-ada3-1bcaab640580";

/** Mock ADO serving a saved query; `queryType` decides the result shape. */
function startServer(queryType: "flat" | "tree") {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const handler = (req: Request): Response => {
    const path = new URL(req.url).pathname;

    if (path === `/Contoso/_apis/wit/queries/${QUERY_GUID}`) {
      return json({ id: QUERY_GUID, name: "Backlog", path: "Shared Queries/Backlog", queryType });
    }
    if (path === "/Contoso/_apis/wit/queries/Shared%20Queries/Backlog") {
      return json({ id: QUERY_GUID, name: "Backlog", path: "Shared Queries/Backlog", queryType });
    }
    if (path === "/Contoso/_apis/wit/queries/Missing") {
      return json({ message: "query not found" }, 404);
    }
    if (path === "/Contoso/_apis/wit/queries") {
      return json({
        count: 2,
        value: [
          {
            id: "f1",
            name: "Shared Queries",
            path: "Shared Queries",
            isFolder: true,
            children: [
              { id: QUERY_GUID, name: "Backlog", path: "Shared Queries/Backlog", queryType: "tree" },
              { id: "q2", name: "Bugs", path: "Shared Queries/Bugs", queryType: "flat" },
            ],
          },
          { id: "q3", name: "Mine", path: "My Queries/Mine", queryType: "flat" },
        ],
      });
    }
    if (path === `/Contoso/_apis/wit/wiql/${QUERY_GUID}`) {
      if (queryType === "flat") {
        return json({ queryType: "flat", workItems: [{ id: 3 }, { id: 1 }, { id: 2 }] });
      }
      return json({
        queryType: "tree",
        workItemRelations: [
          { rel: null, source: null, target: { id: 1 } },
          { rel: "System.LinkTypes.Hierarchy-Forward", source: { id: 1 }, target: { id: 2 } },
          { rel: "System.LinkTypes.Hierarchy-Forward", source: { id: 2 }, target: { id: 3 } },
          // A non-hierarchy link must not count as a parent-child relation.
          { rel: "System.LinkTypes.Related", source: { id: 1 }, target: { id: 4 } },
        ],
      });
    }
    return json({ message: `no mock: ${path}` }, 404);
  };

  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const port = (server.addr as Deno.NetAddr).port;
  return { server, base: `http://localhost:${port}` };
}

function client(base: string) {
  const cfg = makeConfig();
  cfg.ado.baseUrl = base;
  cfg.ado.project = "Contoso";
  return new AdoClient(cfg);
}

Deno.test("a flat query returns a sorted id list", async () => {
  const { server, base } = startServer("flat");
  try {
    const r = await client(base).runStoredQuery(QUERY_GUID);
    assert.equal(r.name, "Backlog");
    assert.equal(r.queryType, "flat");
    assert.deepEqual(r.ids, [1, 2, 3]);
    assert.equal(r.parentByChild.size, 0);
  } finally {
    await server.shutdown();
  }
});

Deno.test("a tree query already supplies parent-child relations", async () => {
  const { server, base } = startServer("tree");
  try {
    const r = await client(base).runStoredQuery(QUERY_GUID);
    assert.equal(r.queryType, "tree");
    // Collect both source and target, including items seen only via a Related link.
    assert.deepEqual(r.ids, [1, 2, 3, 4]);
    assert.equal(r.parentByChild.get(2), 1);
    assert.equal(r.parentByChild.get(3), 2);
    assert.equal(r.parentByChild.get(4), undefined, "a Related link is not a parent-child relation");
    assert.equal(r.parentByChild.get(1), undefined, "the root has no parent");
  } finally {
    await server.shutdown();
  }
});

Deno.test("referencing a query by path also works", async () => {
  const { server, base } = startServer("flat");
  try {
    const r = await client(base).runStoredQuery("Shared Queries/Backlog");
    assert.equal(r.name, "Backlog");
    assert.equal(r.path, "Shared Queries/Backlog");
    assert.deepEqual(r.ids, [1, 2, 3]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("a missing query raises an error that explains tempQueryId", async () => {
  const { server, base } = startServer("flat");
  try {
    await assert.rejects(
      () => client(base).runStoredQuery("Missing"),
      (err: Error) => {
        assert.equal(err.message.includes("tempQueryId"), true, err.message);
        assert.equal(err.message.includes("Save query"), true, err.message);
        return true;
      },
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("listQueries flattens the tree and drops folders", async () => {
  const { server, base } = startServer("tree");
  try {
    const queries = await client(base).listQueries();
    assert.deepEqual(queries.map((q) => q.path), [
      "Shared Queries/Backlog",
      "Shared Queries/Bugs",
      "My Queries/Mine",
    ]);
    assert.equal(queries.every((q) => !q.isFolder), true);
  } finally {
    await server.shutdown();
  }
});
