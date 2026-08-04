import assert from "node:assert/strict";
import { adfToWiki } from "./wiki.ts";
import { htmlToAdf } from "./adf.ts";
import { markdownToAdf } from "./markdown.ts";

const wiki = (md: string) => adfToWiki(markdownToAdf(md));
const fromHtml = (html: string) => adfToWiki(htmlToAdf(html));

Deno.test("an empty doc renders an empty string", () => {
  assert.equal(adfToWiki(null), "");
  assert.equal(adfToWiki({ version: 1, type: "doc", content: [] }), "");
});

Deno.test("headings", () => {
  assert.equal(wiki("# One\n\n### Three"), "h1. One\n\nh3. Three");
});

Deno.test("basic marks", () => {
  assert.equal(wiki("**bold**"), "*bold*");
  assert.equal(wiki("*italic*"), "_italic_");
  assert.equal(wiki("~~struck~~"), "-struck-");
  assert.equal(wiki("`code`"), "{{code}}");
  assert.equal(fromHtml("<p><u>underlined</u></p>"), "+underlined+");
});

Deno.test("links render as [text|url]; bare links are shortened", () => {
  assert.equal(wiki("[the docs](https://ex.com/a)"), "[the docs|https://ex.com/a]");
  assert.equal(wiki("https://ex.com/b"), "[https://ex.com/b]");
});

Deno.test("bullet and ordered lists, including nesting", () => {
  assert.equal(wiki("- one\n- two"), "* one\n* two");
  assert.equal(wiki("1. a\n2. b"), "# a\n# b");
  assert.equal(wiki("- parent\n  - child\n- parent 2"), "* parent\n** child\n* parent 2");
});

Deno.test("a task list becomes Unicode checkboxes", () => {
  assert.equal(wiki("- [x] done\n- [ ] todo"), "* ☑ done\n* ☐ todo");
});

Deno.test("code blocks keep their language", () => {
  assert.equal(wiki("```python\nx = 1\n```"), "{code:python}\nx = 1\n{code}");
  assert.equal(wiki("```\nplain\n```"), "{code}\nplain\n{code}");
});

Deno.test("blockquote and rule", () => {
  assert.equal(wiki("> quoted"), "{quote}\nquoted\n{quote}");
  assert.equal(wiki("---"), "----");
});

Deno.test("tables: headers use ||, cells use |", () => {
  const out = wiki("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(out, "|| A || B ||\n| 1 | 2 |");
});

Deno.test("structure-breaking characters are escaped", () => {
  // An unescaped `|` inside a cell would split the column.
  assert.equal(wiki("a | b"), "a \\| b");
  assert.equal(wiki("use {{'{'}}code{{'}'}}").includes("\\{"), true);
  assert.equal(wiki("array [0]"), "array \\[0\\]");
});

Deno.test("newlines inside a cell become \\\\ instead of breaking the table", () => {
  const doc = markdownToAdf("| A |\n| --- |\n| x |");
  // Inject a hardBreak by hand to simulate multi-line cell content.
  const cell = doc.content[0].content![1].content![0];
  cell.content = [{
    type: "paragraph",
    content: [{ type: "text", text: "line 1" }, { type: "hardBreak" }, { type: "text", text: "line 2" }],
  }];
  const out = adfToWiki(doc);
  assert.equal(out.split("\n").length, 2, `table must stay 2 lines, got: ${JSON.stringify(out)}`);
  assert.equal(out.includes("\\\\"), true);
});

Deno.test("panels map to the matching macro", () => {
  const doc = adfToWiki({
    version: 1,
    type: "doc",
    content: [{
      type: "panel",
      attrs: { panelType: "info" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "a note" }] }],
    }],
  });
  assert.equal(doc, "{info}\na note\n{info}");
});

Deno.test("ADO HTML renders as readable wiki", () => {
  const out = fromHtml("<div>Description in <b>bold</b></div><ul><li>AC1</li><li>AC2</li></ul>");
  assert.equal(out, "Description in *bold*\n\n* AC1\n* AC2");
});

Deno.test("a real markdown sample keeps its structure", () => {
  const out = wiki(`## Background

Ran **100 solves**.

- [ ] Grade \`vanilla-50\`
- [x] Write the script

| # | Change |
| --- | --- |
| C1 | lower to **8000** |`);

  assert.equal(out.includes("h2. Background"), true);
  assert.equal(out.includes("*100 solves*"), true);
  assert.equal(out.includes("* ☐ Grade {{vanilla-50}}"), true);
  assert.equal(out.includes("* ☑ Write the script"), true);
  assert.equal(out.includes("|| # || Change ||"), true);
  assert.equal(out.includes("| C1 | lower to *8000* |"), true);
});

Deno.test("no extra blank lines between blocks", () => {
  const out = wiki("# A\n\nB\n\n- c");
  assert.equal(/\n{3,}/.test(out), false, `extra blank line: ${JSON.stringify(out)}`);
});
