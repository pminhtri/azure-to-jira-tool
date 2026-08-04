import assert from "node:assert/strict";
import { flattenIterations, normalizePath, stripProject } from "./iterations.ts";
import type { AdoClassificationNode } from "./types.ts";

Deno.test("normalizePath drops the Iteration/Area segment ADO inserts", () => {
  assert.equal(normalizePath("\\MyProj\\Iteration\\Sprint 1"), "MyProj\\Sprint 1");
  assert.equal(normalizePath("\\MyProj\\Area\\Team A\\Web"), "MyProj\\Team A\\Web");
  // System.IterationPath is already in the canonical shape.
  assert.equal(normalizePath("MyProj\\Sprint 1"), "MyProj\\Sprint 1");
  assert.equal(normalizePath("MyProj/Sprint 1"), "MyProj\\Sprint 1");
});

Deno.test("normalizePath makes both sources agree", () => {
  assert.equal(
    normalizePath("\\Contoso\\Iteration\\Release 1\\Sprint 3"),
    normalizePath("Contoso\\Release 1\\Sprint 3"),
  );
});

Deno.test("stripProject removes the leading project name", () => {
  assert.equal(stripProject("\\MyProj\\Area\\Team A\\Web"), "Team A\\Web");
  assert.equal(stripProject("MyProj"), "");
});

Deno.test("flattenIterations flattens the tree and takes dates from team settings", () => {
  const tree: AdoClassificationNode = {
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
        ],
      },
    ],
  };

  const flat = flattenIterations(tree, [
    {
      id: "x",
      name: "Release 1",
      path: "Contoso\\Release 1",
      attributes: { startDate: "2023-12-01T00:00:00Z", finishDate: "2024-03-01T00:00:00Z" },
    },
  ]);

  // The root node (depth 0) is dropped.
  assert.deepEqual(flat.map((i) => i.path), ["Contoso\\Release 1", "Contoso\\Release 1\\Sprint 1"]);

  const release = flat[0];
  assert.equal(release.startDate, "2023-12-01T00:00:00Z", "date comes from the team iteration");
  assert.equal(release.isLeaf, false);

  const sprint = flat[1];
  assert.equal(sprint.startDate, "2024-01-01T00:00:00Z");
  assert.equal(sprint.timeFrame, "past");
  assert.equal(sprint.isLeaf, true);
  assert.equal(sprint.depth, 2);
});

Deno.test("an iteration with no dates counts as future", () => {
  const tree: AdoClassificationNode = {
    id: 1,
    identifier: "root",
    name: "P",
    structureType: "iteration",
    hasChildren: true,
    path: "\\P\\Iteration",
    children: [
      {
        id: 2,
        identifier: "b",
        name: "Backlog",
        structureType: "iteration",
        hasChildren: false,
        path: "\\P\\Iteration\\Backlog",
      },
    ],
  };
  const flat = flattenIterations(tree, []);
  assert.equal(flat[0].timeFrame, "future");
  assert.equal(flat[0].startDate, null);
});
