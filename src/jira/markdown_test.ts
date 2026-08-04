import assert from "node:assert/strict";
import { detectFormat, markdownToAdf, richTextToAdf } from "./markdown.ts";
import type { AdfNode } from "./adf.ts";

function flatten(node: unknown): string {
  const n = node as AdfNode;
  if (n.text) return n.text;
  if (n.type === "hardBreak") return "\n";
  return (n.content ?? []).map(flatten).join("");
}

const types = (doc: { content: AdfNode[] }) => doc.content.map((c) => c.type);
const md = (source: string) => markdownToAdf(source);

Deno.test("headings at every level", () => {
  const doc = md("# One\n\n### Three");
  assert.deepEqual(types(doc), ["heading", "heading"]);
  assert.equal((doc.content[0].attrs as { level: number }).level, 1);
  assert.equal((doc.content[1].attrs as { level: number }).level, 3);
  assert.equal(flatten(doc.content[1]), "Three");
});

Deno.test("inline marks: bold, italic, code, strike", () => {
  const doc = md("**bold** *italic* `code` ~~struck~~");
  const nodes = doc.content[0].content!;
  const markOf = (t: string) => nodes.find((n) => n.text === t)?.marks?.map((m) => m.type);
  assert.deepEqual(markOf("bold"), ["strong"]);
  assert.deepEqual(markOf("italic"), ["em"]);
  assert.deepEqual(markOf("code"), ["code"]);
  assert.deepEqual(markOf("struck"), ["strike"]);
});

Deno.test("an underscore inside a word does not start italics", () => {
  const doc = md("call `run_index_dry()` inside snake_case_name");
  assert.equal(flatten(doc.content[0]).includes("snake_case_name"), true);
  const emphasised = (doc.content[0].content ?? []).filter((n) => n.marks?.some((m) => m.type === "em"));
  assert.deepEqual(emphasised, []);
});

Deno.test("markdown links and autolinks", () => {
  const doc = md("see [the docs](https://example.com/a) and https://example.com/b");
  const links = (doc.content[0].content ?? []).filter((n) => n.marks?.some((m) => m.type === "link"));
  assert.equal(links.length, 2);
  assert.equal(links[0].text, "the docs");
  assert.equal(links[0].marks![0].attrs!.href, "https://example.com/a");
  assert.equal(links[1].marks![0].attrs!.href, "https://example.com/b");
});

Deno.test("a relative link loses the mark but keeps its text", () => {
  const doc = md("[internal](./docs/a.md)");
  assert.equal(flatten(doc.content[0]), "internal");
  assert.equal((doc.content[0].content ?? [])[0].marks, undefined);
});

Deno.test("bullet lists and ordered lists", () => {
  const bullets = md("- one\n- two");
  assert.deepEqual(types(bullets), ["bulletList"]);
  assert.equal(bullets.content[0].content!.length, 2);

  const ordered = md("1. one\n2. two\n3. three");
  assert.deepEqual(types(ordered), ["orderedList"]);
  assert.equal(ordered.content[0].content!.length, 3);
});

Deno.test("a nested list lives inside its parent listItem", () => {
  const doc = md("- parent\n  - child\n  - child 2\n- parent 2");
  assert.deepEqual(types(doc), ["bulletList"]);
  const items = doc.content[0].content!;
  assert.equal(items.length, 2);
  assert.equal(items[0].content![0].type, "paragraph");
  assert.equal(items[0].content![1].type, "bulletList");
  assert.equal(items[0].content![1].content!.length, 2);
});

Deno.test("a task list becomes taskList/taskItem with localIds", () => {
  const doc = md("- [x] done\n- [ ] todo\n- [X] done uppercase");
  assert.deepEqual(types(doc), ["taskList"]);
  const items = doc.content[0].content!;
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.attrs!.state), ["DONE", "TODO", "DONE"]);
  assert.equal(flatten(items[0]), "done");
  // localId is mandatory and must be unique.
  const ids = new Set([doc.content[0].attrs!.localId, ...items.map((i) => i.attrs!.localId)]);
  assert.equal(ids.size, 4);
  for (const id of ids) assert.equal(typeof id === "string" && id.length > 0, true);
});

Deno.test("a markdown table builds the header and pads columns", () => {
  const doc = md(
    "| # | Change | Location |\n| --- | --- | --- |\n| C1 | `a` -> **b** | line 60 |\n| C2 | x |",
  );
  assert.deepEqual(types(doc), ["table"]);
  const rows = doc.content[0].content!;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].content![0].type, "tableHeader");
  assert.equal(rows[1].content![0].type, "tableCell");
  // A short row is padded to match the header — Jira rejects ragged tables.
  assert.equal(rows[2].content!.length, 3);
  for (const row of rows) assert.equal(row.content!.length, 3);
  assert.equal(flatten(rows[1].content![1]), "a -> b");
});

Deno.test("a code fence keeps its content and language", () => {
  const doc = md("```python\ndef a():\n    return 1\n```");
  assert.deepEqual(types(doc), ["codeBlock"]);
  assert.equal((doc.content[0].attrs as { language?: string }).language, "python");
  assert.equal(flatten(doc.content[0]), "def a():\n    return 1");
});

Deno.test("blockquote and rule", () => {
  const doc = md("> quoted\n\n---\n\nafter");
  assert.deepEqual(types(doc), ["blockquote", "rule", "paragraph"]);
  assert.equal(flatten(doc.content[0]), "quoted");
});

Deno.test("consecutive lines join into one paragraph with hardBreaks", () => {
  const doc = md("line one\nline two\n\nnew paragraph");
  assert.deepEqual(types(doc), ["paragraph", "paragraph"]);
  assert.equal(flatten(doc.content[0]), "line one\nline two");
  assert.equal(flatten(doc.content[1]), "new paragraph");
});

Deno.test("CommonMark backslash escapes, Windows paths unchanged", () => {
  assert.equal(flatten(md("\\*not italic\\*").content[0]), "*not italic*");
  // \s and \l are not punctuation, so the backslash survives.
  assert.equal(flatten(md("E:\\src\\staging\\python.exe").content[0]), "E:\\src\\staging\\python.exe");
  assert.equal(flatten(md("benchmarks\\swe_bench\\logs").content[0]), "benchmarks\\swe_bench\\logs");
});

Deno.test("HTML entities inside markdown are decoded", () => {
  const doc = md("Replace&nbsp;`_run_index_dry()`&nbsp;in&nbsp;`cli.py`");
  assert.equal(flatten(doc.content[0]).includes("_run_index_dry()"), true);
  assert.equal(flatten(doc.content[0]).includes("&nbsp;"), false);
});

Deno.test("no text node is empty", () => {
  const doc = md("# H\n\n- [ ] \n- a\n\n| a |\n| --- |\n|  |\n\n**  **");
  const walk = (n: AdfNode) => {
    if (n.type === "text") assert.equal((n.text ?? "").length > 0, true, "empty text node");
    for (const c of n.content ?? []) walk(c);
  };
  for (const n of doc.content) walk(n);
});

/* -- Format detection ------------------------------------------------------ */

Deno.test("detectFormat separates HTML from Markdown", () => {
  assert.equal(detectFormat("<div>a</div><ul><li>b</li></ul>"), "html");
  assert.equal(detectFormat("<p>just one paragraph</p>"), "html");
  assert.equal(detectFormat("## Heading\n\n- [ ] task"), "markdown");
  assert.equal(detectFormat("| a | b |\n| --- | --- |\n| 1 | 2 |"), "markdown");
  // Has &nbsp; and backticks but no block tags -> markdown.
  assert.equal(detectFormat("Replace&nbsp;`a()`&nbsp;with `b()`"), "markdown");
  // Plain prose with no signal at all.
  assert.equal(detectFormat("just a sentence"), "markdown");
});

Deno.test("richTextToAdf picks the right converter", () => {
  const html = richTextToAdf("<ul><li>one</li><li>two</li></ul>");
  assert.deepEqual(types(html), ["bulletList"]);

  const markdown = richTextToAdf("## Section\n\n- [x] done");
  assert.deepEqual(types(markdown), ["heading", "taskList"]);

  assert.deepEqual(richTextToAdf("").content, []);
  assert.deepEqual(richTextToAdf(null).content, []);
});

Deno.test("a real ADO export sample keeps its structure", () => {
  const source = `## Background

Verified-50 2-arm campaign ran (100 solves, chunks 1-5). \`vanilla-50\` predictions valid.

**P1 - closeout (must, $0)**
- [ ] Grade \`vanilla-50\` on grader host -> scorecard + run-record.
- [x] Formalize the measure into a reusable script.

## Out of scope (this week)

- The paid 2-arm re-run.
`;
  const doc = md(source);
  assert.deepEqual(types(doc), ["heading", "paragraph", "paragraph", "taskList", "heading", "bulletList"]);
  const tasks = doc.content[3].content!;
  assert.deepEqual(tasks.map((t) => t.attrs!.state), ["TODO", "DONE"]);
  assert.equal(flatten(doc.content[0]), "Background");
});
