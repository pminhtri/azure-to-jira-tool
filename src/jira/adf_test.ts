import assert from "node:assert/strict";
import { htmlToAdf, textToAdf } from "./adf.ts";

/** Flatten ADF down to plain text so assertions stay short. */
function flatten(node: unknown): string {
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.text) return n.text;
  if (n.type === "hardBreak") return "\n";
  return (n.content ?? []).map(flatten).join("");
}

const types = (doc: { content: { type: string }[] }) => doc.content.map((c) => c.type);

Deno.test("empty html produces an empty doc", () => {
  assert.deepEqual(htmlToAdf("").content, []);
  assert.deepEqual(htmlToAdf(null).content, []);
  assert.deepEqual(htmlToAdf("   ").content, []);
});

Deno.test("both paragraph and div become a paragraph", () => {
  const doc = htmlToAdf("<div>Hello</div><p>world</p>");
  assert.deepEqual(types(doc), ["paragraph", "paragraph"]);
  assert.equal(flatten(doc.content[0]), "Hello");
  assert.equal(flatten(doc.content[1]), "world");
});

Deno.test("heading keeps its level", () => {
  const doc = htmlToAdf("<h2>Title</h2><h5>Small</h5>");
  assert.deepEqual(types(doc), ["heading", "heading"]);
  assert.equal((doc.content[0].attrs as { level: number }).level, 2);
  assert.equal((doc.content[1].attrs as { level: number }).level, 5);
});

Deno.test("nested marks are merged", () => {
  const doc = htmlToAdf("<p><strong><em>bold italic</em></strong></p>");
  const textNode = (doc.content[0].content ?? [])[0] as { marks?: { type: string }[] };
  const marks = (textNode.marks ?? []).map((m) => m.type).sort();
  assert.deepEqual(marks, ["em", "strong"]);
});

Deno.test("valid links keep href, junk links lose the mark", () => {
  const ok = htmlToAdf('<p><a href="https://example.com">click</a></p>');
  const okNode = (ok.content[0].content ?? [])[0] as { marks?: { type: string; attrs?: { href: string } }[] };
  assert.equal(okNode.marks?.[0].type, "link");
  assert.equal(okNode.marks?.[0].attrs?.href, "https://example.com");

  const bad = htmlToAdf('<p><a href="javascript:alert(1)">bad</a></p>');
  const badNode = (bad.content[0].content ?? [])[0] as { marks?: unknown[] };
  assert.equal(badNode.marks, undefined);
  assert.equal(flatten(bad.content[0]), "bad");
});

Deno.test("an ADO mention becomes plain text", () => {
  const doc = htmlToAdf(
    '<p><a href="#" data-vss-mention="version:2.0,guid">@Nguyen Van A</a> please review</p>',
  );
  assert.equal(flatten(doc.content[0]), "@Nguyen Van A please review");
  const node = (doc.content[0].content ?? [])[0] as { marks?: unknown[] };
  assert.equal(node.marks, undefined);
});

Deno.test("nested lists, and every listItem starts with a paragraph", () => {
  const doc = htmlToAdf("<ul><li>one</li><li><ul><li>two</li></ul></li></ul>");
  assert.deepEqual(types(doc), ["bulletList"]);
  const items = doc.content[0].content ?? [];
  assert.equal(items.length, 2);
  for (const li of items) {
    assert.equal(li.type, "listItem");
    assert.equal((li.content ?? [])[0].type, "paragraph");
  }
  assert.equal((items[1].content ?? [])[1].type, "bulletList");
});

Deno.test("orderedList is recognised", () => {
  const doc = htmlToAdf("<ol><li>a</li></ol>");
  assert.deepEqual(types(doc), ["orderedList"]);
});

Deno.test("tables build all rows/cells and distinguish headers", () => {
  const doc = htmlToAdf("<table><tr><th>Column</th></tr><tr><td>Value</td></tr></table>");
  assert.deepEqual(types(doc), ["table"]);
  const rows = doc.content[0].content ?? [];
  assert.equal(rows.length, 2);
  assert.equal((rows[0].content ?? [])[0].type, "tableHeader");
  assert.equal((rows[1].content ?? [])[0].type, "tableCell");
  assert.equal(flatten(rows[1]), "Value");
});

Deno.test("codeBlock keeps content and guesses the language", () => {
  const doc = htmlToAdf('<pre><code class="language-ts">const a = 1;\nconst b = 2;</code></pre>');
  assert.deepEqual(types(doc), ["codeBlock"]);
  assert.equal((doc.content[0].attrs as { language?: string }).language, "ts");
  assert.equal(flatten(doc.content[0]), "const a = 1;\nconst b = 2;");
});

Deno.test("br becomes hardBreak and is trimmed at both paragraph ends", () => {
  const doc = htmlToAdf("<p><br>one<br>two<br></p>");
  assert.equal(flatten(doc.content[0]), "one\ntwo");
});

Deno.test("HTML entities are decoded", () => {
  const doc = htmlToAdf("<p>a &amp; b &lt;c&gt; &quot;d&quot; &nbsp;e</p>");
  assert.equal(flatten(doc.content[0]).replace(/ /g, " "), 'a & b <c> "d" e');
});

Deno.test("blockquote only keeps valid child nodes", () => {
  const doc = htmlToAdf("<blockquote><p>quoted</p><table><tr><td>x</td></tr></table></blockquote>");
  assert.deepEqual(types(doc), ["blockquote"]);
  const inner = doc.content[0].content ?? [];
  assert.deepEqual(inner.map((n) => n.type), ["paragraph"]);
});

Deno.test("ADO attachment images resolve through the context", () => {
  const guid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const html =
    `<p>before<img src="https://dev.azure.com/o/p/_apis/wit/attachments/${guid}?fileName=a.png">after</p>`;

  const asLink = htmlToAdf(html, {
    resolveImage: (g, name) => ({ kind: "link", href: `https://jira/att/${g}`, text: name }),
  });
  assert.equal(flatten(asLink).includes("a.png"), true);

  const asMedia = htmlToAdf(html, {
    resolveImage: () => ({ kind: "media", id: "10001" }),
  });
  // mediaSingle is a block, so it must be split out of the paragraph.
  assert.deepEqual(types(asMedia), ["paragraph", "mediaSingle", "paragraph"]);
  assert.equal(flatten(asMedia.content[0]), "before");
  assert.equal(flatten(asMedia.content[2]), "after");
});

Deno.test("an unresolvable image becomes placeholder text", () => {
  const guid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const doc = htmlToAdf(
    `<p><img src="https://dev.azure.com/o/p/_apis/wit/attachments/${guid}?fileName=b.png"></p>`,
  );
  assert.equal(flatten(doc).includes("b.png"), true);
});

Deno.test("messy ADO HTML produces no empty nodes", () => {
  const doc = htmlToAdf("<div><div><br></div></div><p>&nbsp;</p><div>content</div>");
  // No paragraph may hold nothing but whitespace.
  for (const node of doc.content) {
    if (node.type === "paragraph" && node.content) {
      assert.equal(node.content.length > 0, true);
    }
  }
  assert.equal(flatten(doc).includes("content"), true);
});

Deno.test("no text node is empty (Jira rejects empty text)", () => {
  const doc = htmlToAdf("<p>a<span></span>b</p><ul><li></li></ul><table><tr><td></td></tr></table>");
  const walk = (n: { type: string; text?: string; content?: unknown[] }) => {
    if (n.type === "text") assert.equal((n.text ?? "").length > 0, true, "found an empty text node");
    for (const c of (n.content ?? []) as typeof n[]) walk(c);
  };
  for (const node of doc.content) walk(node);
});

Deno.test("over-long content is truncated with a warning", () => {
  const html = "<p>" + "x".repeat(200) + "</p>";
  const doc = htmlToAdf(html.repeat(400));
  const json = JSON.stringify(doc);
  assert.equal(json.length < 40_000, true, `length ${json.length}`);
  assert.equal(doc.content[doc.content.length - 1].type, "panel");
});

Deno.test("textToAdf preserves line breaks", () => {
  const doc = textToAdf("line 1\n\nline 2");
  assert.equal(doc.content.length, 3);
  assert.equal(flatten(doc.content[0]), "line 1");
  assert.equal(doc.content[1].content, undefined);
  assert.equal(flatten(doc.content[2]), "line 2");
});
