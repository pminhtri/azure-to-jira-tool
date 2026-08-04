import assert from "node:assert/strict";
import { join } from "node:path";
import { runCsvImport } from "./csv.ts";
import { DataLayout } from "./export.ts";
import { makeConfig } from "../testing/fixtures.ts";
import type { MappingConfig } from "../config.ts";
import { setVerbose } from "../log.ts";

setVerbose(false);

/** Run runCsvImport over the given CSV content inside a temp directory. */
async function convert(csv: string, mapping: Partial<MappingConfig> = {}) {
  const tmp = await Deno.makeTempDir({ prefix: "csv-e2e-" });
  const file = join(tmp, "export.csv");
  await Deno.writeTextFile(file, csv);
  const cfg = makeConfig({ dataDir: join(tmp, "data"), stateDir: join(tmp, "state"), mapping });
  const result = await runCsvImport(cfg, { files: [file] });
  const layout = new DataLayout(cfg.dataDir);
  return {
    ...result,
    layout,
    cleanup: () => Deno.remove(tmp, { recursive: true }).catch(() => {}),
  };
}

const HEADER = "ID,Work Item Type,Title,Assigned To,State,Tags,Created Date,Created By," +
  "Changed Date,Area Path,Iteration Path,Description,Backlog Priority,Attached File Count,History";

Deno.test("CSV -> .data: fields, identity, dates, iterations", async () => {
  const csv = `﻿${HEADER}
"760","Task","Embed images into the vector store","Leroy Bakker <leroy.bakker@sioux.eu>","Done",,"3/4/2026 6:55:03 PM","Leroy Bakker <leroy.bakker@sioux.eu>","3/5/2026 2:58:05 PM","Context Engine","Context Engine\\Sprint 1","<div>An <b>HTML</b> description</div>","100","0","Completed PR 255"
"761","Feature","File tree view in the UI",,"New","urgent; ui","3/4/2026 7:02:19 PM","Leroy Bakker <leroy.bakker@sioux.eu>","6/15/2026 7:10:00 PM","Context Engine","Context Engine","## Heading

- [x] done
- [ ] todo","200","1",
`;
  const r = await convert(csv);
  try {
    assert.equal(r.manifest.workItemCount, 2);
    assert.deepEqual(r.manifest.typeCounts, { Task: 1, Feature: 1 });
    assert.deepEqual(r.manifest.stateCounts, { Done: 1, New: 1 });

    const a = (await r.layout.readWorkItem(760))!;
    assert.equal(a.workItem.fields["System.Title"], "Embed images into the vector store");
    assert.deepEqual(a.workItem.fields["System.AssignedTo"], {
      displayName: "Leroy Bakker",
      uniqueName: "leroy.bakker@sioux.eu",
    });
    assert.equal(a.workItem.fields["System.CreatedDate"], "2026-03-04T18:55:03.000Z");
    assert.equal(a.workItem.fields["Microsoft.VSTS.Common.BacklogPriority"], 100);
    // The History column becomes a single comment.
    assert.equal(a.comments.length, 1);
    assert.equal(a.comments[0].text, "Completed PR 255");

    const b = (await r.layout.readWorkItem(761))!;
    assert.equal(b.workItem.fields["System.Tags"], "urgent; ui");
    assert.equal(b.workItem.fields["System.AssignedTo"], undefined);
    // A multi-line description inside a quoted field survives intact.
    assert.equal((b.workItem.fields["System.Description"] as string).includes("- [x] done"), true);
    assert.equal(b.comments.length, 0);

    // Only child iterations become sprints; "Context Engine" is the root backlog.
    const iterations = await r.layout.readIterations();
    assert.deepEqual(iterations.map((i) => i.path), ["Context Engine\\Sprint 1"]);
    assert.equal(iterations[0].startDate, null);

    // The warnings must name all three things a CSV cannot carry.
    const joined = r.warnings.join("\n");
    assert.equal(joined.includes("Parent"), true, "must warn about the missing hierarchy");
    assert.equal(joined.includes("attachment"), true, "must warn about lost attachments");
    assert.equal(joined.includes("History"), true, "must warn that History is incomplete");
  } finally {
    await r.cleanup();
  }
});

Deno.test("the Parent column builds the hierarchy", async () => {
  const csv = `ID,Work Item Type,Title,State,Parent,Area Path,Iteration Path
"1","Epic","Platform","New",,"P","P"
"2","Feature","Payments","New","1","P","P"
"3","Task","Credit card","New","2","P","P"
"4","Task","Orphan","New","999","P","P"
`;
  const r = await convert(csv);
  try {
    assert.equal((await r.layout.readWorkItem(2))!.workItem.fields["System.Parent"], 1);
    assert.equal((await r.layout.readWorkItem(3))!.workItem.fields["System.Parent"], 2);
    // A Parent pointing at an id absent from the file is dropped, so the hierarchy phase cannot fail.
    assert.equal((await r.layout.readWorkItem(4))!.workItem.fields["System.Parent"], undefined);
    assert.equal(r.warnings.some((w) => w.includes("CANNOT be migrated")), false);
  } finally {
    await r.cleanup();
  }
});

Deno.test("a tree export (Title 1/2/3) builds the hierarchy", async () => {
  const csv = `ID,Work Item Type,Title 1,Title 2,Title 3,State,Area Path,Iteration Path
"1","Epic","Platform",,,"New","P","P"
"2","Feature",,"Payments",,"New","P","P"
"3","Task",,,"Credit card","New","P","P"
"4","Task",,,"Bank transfer","New","P","P"
"5","Feature",,"Refunds",,"New","P","P"
"6","Epic","Reporting",,,"New","P","P"
"7","Task",,,"CSV export","New","P","P"
`;
  const r = await convert(csv);
  try {
    const parent = async (id: number) => (await r.layout.readWorkItem(id))!.workItem.fields["System.Parent"];
    assert.equal(await parent(1), undefined, "the root Epic has no parent");
    assert.equal(await parent(2), 1);
    assert.equal(await parent(3), 2);
    assert.equal(await parent(4), 2, "siblings at the same level share a parent");
    assert.equal(await parent(5), 1, "returning to level 2 still belongs to Epic 1");
    assert.equal(await parent(6), undefined, "a new Epic resets the stack");
    assert.equal(await parent(7), 6, "Title 3 falls under the Epic when Title 2 is absent");

    // Title columns also serve as the summary when no plain Title column exists.
    assert.equal(r.manifest.workItemCount, 7);
  } finally {
    await r.cleanup();
  }
});

Deno.test("Removed work items are dropped by default and kept when the option is on", async () => {
  const csv = `ID,Work Item Type,Title,State,Area Path,Iteration Path
"1","Task","Still used","New","P","P"
"2","Task","Discarded","Removed","P","P"
`;
  const dropped = await convert(csv);
  try {
    assert.deepEqual(dropped.manifest.workItemIds, [1]);
  } finally {
    await dropped.cleanup();
  }

  const kept = await convert(csv, {
    options: { ...makeConfig().mapping.options, includeRemovedWorkItems: true },
  });
  try {
    assert.deepEqual(kept.manifest.workItemIds, [1, 2]);
  } finally {
    await kept.cleanup();
  }
});

Deno.test("sprintDates from the config are applied to iterations", async () => {
  const csv = `ID,Work Item Type,Title,State,Area Path,Iteration Path
"1","Task","A","New","P","P\\Sprint 1"
`;
  const r = await convert(csv, {
    sprintDates: { "P\\Sprint 1": { start: "2026-01-01", end: "2026-01-14" } },
  });
  try {
    const [sprint] = await r.layout.readIterations();
    assert.equal(sprint.startDate, "2026-01-01T00:00:00.000Z");
    assert.equal(sprint.finishDate, "2026-01-14T00:00:00.000Z");
    assert.equal(sprint.timeFrame, "past");
    assert.equal(r.warnings.some((w) => w.includes("no iteration start/finish dates")), false);
  } finally {
    await r.cleanup();
  }
});

Deno.test("several files merge by ID, later files winning", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "csv-merge-" });
  const head = "ID,Work Item Type,Title,State,Area Path,Iteration Path,Description";
  // File A is broader; file B is a subset plus one unique item and one newer title.
  const a = join(tmp, "a.csv");
  const b = join(tmp, "b.csv");
  await Deno.writeTextFile(
    a,
    `${head}\n"1","Task","Old","New","P","P",""\n"2","Task","Only in A","Done","P","P",""\n`,
  );
  await Deno.writeTextFile(
    b,
    `${head}\n"1","Task","Newer","Done","P","P","extra description"\n"3","Bug","Only in B","New","P","P",""\n`,
  );

  const cfg = makeConfig({ dataDir: join(tmp, "data"), stateDir: join(tmp, "state") });
  const result = await runCsvImport(cfg, { files: [a, b] });
  const layout = new DataLayout(cfg.dataDir);
  try {
    // Union of both files, losing nothing that appears in only one.
    assert.deepEqual(result.manifest.workItemIds, [1, 2, 3]);

    // Attachments are counted per work item, not summed across repeats.
    const attachmentWarning = result.warnings.find((w) => w.includes("attachment"));
    assert.equal(attachmentWarning, undefined, "neither of these files has attachments");

    const one = (await layout.readWorkItem(1))!;
    assert.equal(one.workItem.fields["System.Title"], "Newer", "the later file must win");
    assert.equal(one.workItem.fields["System.State"], "Done");
    assert.equal(one.workItem.fields["System.Description"], "extra description");

    assert.equal((await layout.readWorkItem(2))!.workItem.fields["System.Title"], "Only in A");
    assert.equal((await layout.readWorkItem(3))!.workItem.fields["System.Title"], "Only in B");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("attachments are counted per work item, not summed across files", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "csv-att-" });
  const head = "ID,Work Item Type,Title,State,Area Path,Iteration Path,Attached File Count";
  const a = join(tmp, "a.csv");
  const b = join(tmp, "b.csv");
  // Item 1 has 2 attachments and appears in BOTH exports.
  await Deno.writeTextFile(a, `${head}\n"1","Task","A","New","P","P","2"\n`);
  await Deno.writeTextFile(
    b,
    `${head}\n"1","Task","A","New","P","P","2"\n"2","Task","B","New","P","P","3"\n`,
  );

  const cfg = makeConfig({ dataDir: join(tmp, "data"), stateDir: join(tmp, "state") });
  const result = await runCsvImport(cfg, { files: [a, b] });
  try {
    const warning = result.warnings.find((w) => w.includes("attachment"))!;
    assert.notEqual(warning, undefined);
    assert.equal(warning.startsWith("5 attachment"), true, `expected 5 (2+3), got: ${warning}`);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("a file contributing no new items is reported", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "csv-subset-" });
  const head = "ID,Work Item Type,Title,State,Area Path,Iteration Path";
  const full = join(tmp, "full.csv");
  const subset = join(tmp, "subset.csv");
  await Deno.writeTextFile(full, `${head}\n"1","Task","A","New","P","P"\n"2","Task","B","New","P","P"\n`);
  await Deno.writeTextFile(subset, `${head}\n"1","Task","A","New","P","P"\n`);

  const cfg = makeConfig({ dataDir: join(tmp, "data"), stateDir: join(tmp, "state") });
  const result = await runCsvImport(cfg, { files: [full, subset] });
  try {
    assert.deepEqual(result.manifest.workItemIds, [1, 2]);
    assert.equal(
      result.warnings.some((w) => w.includes("subset.csv") && w.includes("contributed no new work items")),
      true,
      `must warn about the redundant file, got: ${JSON.stringify(result.warnings)}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("a CSV without an ID column fails with a clear error", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "csv-e2e-" });
  const file = join(tmp, "bad.csv");
  await Deno.writeTextFile(file, "Title,State\nA,New\n");
  const cfg = makeConfig({ dataDir: join(tmp, "data"), stateDir: join(tmp, "state") });
  await assert.rejects(
    () => runCsvImport(cfg, { files: [file] }),
    (err: Error) => err.message.includes('is missing the "ID" column'),
  );
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
});
