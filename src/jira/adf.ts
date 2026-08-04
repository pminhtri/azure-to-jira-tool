import { type HTMLElement, type Node, parse as parseHtml } from "node-html-parser";

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

/** How to render an embedded image once its Jira attachment is known. */
export type ImageResolution =
  | { kind: "link"; href: string; text: string }
  | { kind: "media"; id: string; width?: number; height?: number }
  | { kind: "text"; text: string };

export interface AdfContext {
  /** Look up an embedded image by its ADO attachment GUID. */
  resolveImage?: (guid: string, fileName: string) => ImageResolution | null;
  /** Character budget (Jira caps text fields at ~32,767 characters). */
  maxChars?: number;
}

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "PRE",
  "BLOCKQUOTE",
  "TABLE",
  "HR",
  "SECTION",
  "ARTICLE",
  "ASIDE",
  "HEADER",
  "FOOTER",
  "FIGURE",
  "DL",
  "FIELDSET",
]);

const MARK_TAGS: Record<string, AdfMark> = {
  STRONG: { type: "strong" },
  B: { type: "strong" },
  EM: { type: "em" },
  I: { type: "em" },
  U: { type: "underline" },
  INS: { type: "underline" },
  S: { type: "strike" },
  STRIKE: { type: "strike" },
  DEL: { type: "strike" },
  CODE: { type: "code" },
  KBD: { type: "code" },
  SAMP: { type: "code" },
  SUB: { type: "subsup", attrs: { type: "sub" } },
  SUP: { type: "subsup", attrs: { type: "sup" } },
};

/** Tags dropped entirely, including their contents. */
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT"]);

const ATTACHMENT_GUID = /\/_apis\/wit\/attachments\/([0-9a-fA-F-]{36})/;

/** node-html-parser has no `children` getter, only `childNodes`. */
function elementChildren(el: HTMLElement): HTMLElement[] {
  return el.childNodes.filter((n) => n.nodeType === NODE_ELEMENT) as HTMLElement[];
}

function tagOf(node: Node): string {
  return (node as HTMLElement).tagName ?? "";
}

export const emptyDoc = (): AdfDoc => ({ version: 1, type: "doc", content: [] });

export const isEmptyDoc = (doc: AdfDoc) => !doc.content.length;

/** Wrap plain text into an ADF document, preserving line breaks. */
export function textToAdf(text: string): AdfDoc {
  const content = text.split(/\r?\n/).map((line): AdfNode =>
    line.trim() ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }
  );
  return { version: 1, type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

export function paragraph(...content: AdfNode[]): AdfNode {
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

export function text(value: string, marks?: AdfMark[]): AdfNode {
  return marks?.length ? { type: "text", text: value, marks } : { type: "text", text: value };
}

export function link(label: string, href: string): AdfNode {
  return text(label, [{ type: "link", attrs: { href } }]);
}

export function panel(
  panelType: "info" | "note" | "warning" | "success" | "error",
  content: AdfNode[],
): AdfNode {
  return { type: "panel", attrs: { panelType }, content: content.length ? content : [paragraph()] };
}

/** Concatenate ADF documents, optionally inserting a rule between parts. */
export function concatDocs(docs: (AdfDoc | null | undefined)[], separator = false): AdfDoc {
  const content: AdfNode[] = [];
  for (const doc of docs) {
    if (!doc || !doc.content.length) continue;
    if (content.length && separator) content.push({ type: "rule" });
    content.push(...doc.content);
  }
  return { version: 1, type: "doc", content };
}

/**
 * Convert Azure DevOps rich-text HTML into ADF.
 *
 * Perfect fidelity is not the goal — the aim is to keep the readable structure
 * (headings, lists, tables, code, links, images) and to never emit invalid ADF,
 * because Jira rejects the whole issue if a single node breaks the schema.
 */
export function htmlToAdf(html: string | null | undefined, ctx: AdfContext = {}): AdfDoc {
  if (!html || !html.trim()) return emptyDoc();

  let root: HTMLElement;
  try {
    root = parseHtml(html, { comment: false });
  } catch {
    return textToAdf(stripTags(html));
  }

  const converter = new Converter(ctx);
  let content = converter.blocks([...root.childNodes]);
  content = normalizeTop(content);
  if (!content.length) {
    const plain = stripTags(html).trim();
    return plain ? textToAdf(plain) : emptyDoc();
  }
  return truncate({ version: 1, type: "doc", content }, ctx.maxChars ?? 30_000);
}

class Converter {
  constructor(private ctx: AdfContext) {}

  /** Convert a list of HTML nodes into a list of ADF blocks. */
  blocks(nodes: Node[]): AdfNode[] {
    const out: AdfNode[] = [];
    let inlineBuffer: AdfNode[] = [];

    const flush = () => {
      const trimmed = trimInline(inlineBuffer);
      if (trimmed.length) out.push({ type: "paragraph", content: trimmed });
      inlineBuffer = [];
    };

    for (const node of nodes) {
      if (node.nodeType === NODE_ELEMENT && DROP_TAGS.has(tagOf(node))) continue;
      if (node.nodeType === NODE_ELEMENT && BLOCK_TAGS.has(tagOf(node))) {
        flush();
        out.push(...this.block(node as HTMLElement));
      } else {
        inlineBuffer.push(...this.inline(node, []));
      }
    }
    flush();
    return out;
  }

  private block(el: HTMLElement): AdfNode[] {
    const tag = el.tagName;

    switch (tag) {
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6": {
        const content = trimInline(this.inlineChildren(el));
        if (!content.length) return [];
        return [{ type: "heading", attrs: { level: Number(tag[1]) }, content }];
      }

      case "HR":
        return [{ type: "rule" }];

      case "PRE": {
        // node-html-parser treats <pre> as block-text: textContent returns the raw
        // inner HTML, so tags must be stripped and entities decoded here.
        const raw = el.textContent ?? "";
        const code = decodeEntities(raw.replace(/<[^>]+>/g, ""))
          .replace(/\r\n/g, "\n")
          .replace(/^\n+/, "")
          .replace(/\s+$/, "");
        if (!code) return [];
        const lang = detectLanguage(raw, el.getAttribute("class"));
        return [{
          type: "codeBlock",
          attrs: lang ? { language: lang } : {},
          content: [{ type: "text", text: code }],
        }];
      }

      case "BLOCKQUOTE": {
        const inner = normalizeBlockquote(this.blocks([...el.childNodes]));
        return inner.length ? [{ type: "blockquote", content: inner }] : [];
      }

      case "UL":
      case "OL":
        return this.list(el);

      case "TABLE":
        return this.table(el);

      case "DL":
        return this.definitionList(el);

      default: {
        // DIV / P / SECTION… — ADO often nests divs instead of using paragraphs.
        const children = this.blocks([...el.childNodes]);
        return children;
      }
    }
  }

  private list(el: HTMLElement): AdfNode[] {
    const items: AdfNode[] = [];
    for (const child of elementChildren(el)) {
      if (child.tagName !== "LI") continue;
      let content = this.blocks([...child.childNodes]);
      // A listItem must start with a paragraph.
      if (!content.length) content = [{ type: "paragraph" }];
      if (content[0].type !== "paragraph") content.unshift({ type: "paragraph" });
      items.push({ type: "listItem", content });
    }
    if (!items.length) return [];
    return [{ type: el.tagName === "OL" ? "orderedList" : "bulletList", content: items }];
  }

  private table(el: HTMLElement): AdfNode[] {
    const rows: AdfNode[] = [];
    const trs = el.querySelectorAll("tr");
    let columns = 0;

    for (const tr of trs) {
      const cells: AdfNode[] = [];
      for (const cell of elementChildren(tr)) {
        if (cell.tagName !== "TD" && cell.tagName !== "TH") continue;
        let content = this.blocks([...cell.childNodes]);
        if (!content.length) content = [{ type: "paragraph" }];
        const attrs: Record<string, unknown> = {};
        const colspan = Number(cell.getAttribute("colspan"));
        const rowspan = Number(cell.getAttribute("rowspan"));
        if (colspan > 1) attrs.colspan = colspan;
        if (rowspan > 1) attrs.rowspan = rowspan;
        cells.push({
          type: cell.tagName === "TH" ? "tableHeader" : "tableCell",
          attrs,
          content,
        });
      }
      if (!cells.length) continue;
      columns = Math.max(columns, cells.length);
      rows.push({ type: "tableRow", content: cells });
    }
    if (!rows.length) return [];
    return [{ type: "table", attrs: { isNumberColumnEnabled: false, layout: "default" }, content: rows }];
  }

  private definitionList(el: HTMLElement): AdfNode[] {
    const out: AdfNode[] = [];
    for (const child of elementChildren(el)) {
      const inline = trimInline(this.inlineChildren(child));
      if (!inline.length) continue;
      if (child.tagName === "DT") {
        out.push({ type: "paragraph", content: inline.map((n) => addMark(n, { type: "strong" })) });
      } else if (child.tagName === "DD") {
        out.push({ type: "blockquote", content: [{ type: "paragraph", content: inline }] });
      }
    }
    return out;
  }

  private inlineChildren(el: HTMLElement): AdfNode[] {
    return [...el.childNodes].flatMap((n) => this.inline(n, []));
  }

  /** Convert one inline HTML node into ADF text/hardBreak/media nodes. */
  private inline(node: Node, marks: AdfMark[]): AdfNode[] {
    if (node.nodeType === NODE_TEXT) {
      const value = collapse(node.textContent ?? "");
      return value ? [text(value, marks)] : [];
    }
    if (node.nodeType !== NODE_ELEMENT) return [];

    const el = node as HTMLElement;
    const tag = el.tagName;

    if (DROP_TAGS.has(tag)) return [];
    if (tag === "BR") return [{ type: "hardBreak" }];
    if (tag === "IMG") return this.image(el, marks);

    if (tag === "A") {
      const href = normalizeHref(el.getAttribute("href"));
      // ADO mention: <a href="#" data-vss-mention="...">@Name</a>
      const label = collapse(el.textContent) || href || "";
      if (!label) return [];
      if (!href || el.hasAttribute("data-vss-mention")) return [text(label, marks)];
      const nextMarks = dedupeMarks([...marks, { type: "link", attrs: { href } }]);
      const children = [...el.childNodes].flatMap((c) => this.inline(c, nextMarks));
      return children.length ? children : [text(label, nextMarks)];
    }

    if (BLOCK_TAGS.has(tag)) {
      // A block landed in inline context (ADO HTML is messy) — flatten it.
      const flat = [...el.childNodes].flatMap((c) => this.inline(c, marks));
      return flat.length ? [...flat, { type: "hardBreak" } as AdfNode] : [];
    }

    const mark = MARK_TAGS[tag];
    const nextMarks = mark ? dedupeMarks([...marks, mark]) : marks;
    return [...el.childNodes].flatMap((c) => this.inline(c, nextMarks));
  }

  private image(el: HTMLElement, marks: AdfMark[]): AdfNode[] {
    const src = el.getAttribute("src") ?? "";
    const alt = el.getAttribute("alt") || "";
    const guid = ATTACHMENT_GUID.exec(src)?.[1];
    let fileName = alt || "image";
    try {
      fileName = new URL(src, "https://x.invalid").searchParams.get("fileName") ?? fileName;
    } catch { /* src is not parseable */ }

    const resolved = guid ? this.ctx.resolveImage?.(guid, fileName) : null;
    if (resolved?.kind === "link") return [link(resolved.text, resolved.href)];
    if (resolved?.kind === "media") {
      return [{
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [{
          type: "media",
          attrs: {
            id: resolved.id,
            type: "file",
            collection: "",
            ...(resolved.width ? { width: resolved.width } : {}),
            ...(resolved.height ? { height: resolved.height } : {}),
          },
        }],
      }];
    }
    if (resolved?.kind === "text") return [text(resolved.text, marks)];

    // External image (not an ADO attachment) -> keep it as a link.
    if (/^https?:\/\//i.test(src)) return [link(alt || fileName, src)];
    return [text(`[image: ${fileName}]`, marks)];
  }
}

/* -- Post-processing ------------------------------------------------------ */

/** mediaSingle is a block and cannot sit inside a paragraph -> lift it to top level. */
function normalizeTop(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes) {
    if (node.type !== "paragraph" || !node.content) {
      out.push(node);
      continue;
    }
    let buffer: AdfNode[] = [];
    for (const child of node.content) {
      if (child.type === "mediaSingle") {
        if (trimInline(buffer).length) out.push({ type: "paragraph", content: trimInline(buffer) });
        buffer = [];
        out.push(child);
      } else {
        buffer.push(child);
      }
    }
    const rest = trimInline(buffer);
    if (rest.length) out.push({ type: "paragraph", content: rest });
  }
  return out;
}

/** blockquote only accepts paragraph / list / codeBlock / heading. */
function normalizeBlockquote(nodes: AdfNode[]): AdfNode[] {
  const allowed = new Set(["paragraph", "bulletList", "orderedList", "codeBlock", "heading", "mediaSingle"]);
  return nodes.filter((n) => allowed.has(n.type));
}

/** Trim leading/trailing hardBreaks and whitespace, and drop empty text nodes. */
function trimInline(nodes: AdfNode[]): AdfNode[] {
  const out = nodes.filter((n) => n.type !== "text" || (n.text ?? "").length > 0);
  while (out.length && out[0].type === "hardBreak") out.shift();
  while (out.length && out[out.length - 1].type === "hardBreak") out.pop();
  if (out.length === 1 && out[0].type === "text" && !out[0].text?.trim()) return [];
  return out;
}

function addMark(node: AdfNode, mark: AdfMark): AdfNode {
  if (node.type !== "text") return node;
  return { ...node, marks: dedupeMarks([...(node.marks ?? []), mark]) };
}

function dedupeMarks(marks: AdfMark[]): AdfMark[] {
  const seen = new Map<string, AdfMark>();
  for (const m of marks) seen.set(m.type + JSON.stringify(m.attrs ?? {}), m);
  // `code` cannot combine with link/strong in ADF -> code wins.
  const list = [...seen.values()];
  if (list.some((m) => m.type === "code")) {
    return list.filter((m) => m.type === "code" || m.type === "link");
  }
  return list;
}

function collapse(value: string): string {
  return value.replace(/ /g, " ").replace(/[ \t\r\n]+/g, " ");
}

function normalizeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed === "#" || trimmed.toLowerCase().startsWith("javascript:")) return null;
  if (/^(https?|mailto|ftp):/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return null;
}

/** Guess the code language from the class on `<pre>` or the inner `<code>`. */
function detectLanguage(rawInner: string, preClass: string | null | undefined): string | null {
  const source = `${preClass ?? ""} ${/class\s*=\s*["']([^"']+)["']/i.exec(rawInner)?.[1] ?? ""}`;
  const m = /(?:language|lang|brush:?)[-\s:]([a-z0-9+#]+)/i.exec(source);
  return m ? m[1].toLowerCase() : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/\n{3,}/g, "\n\n");
}

/** Truncate the document if it exceeds Jira's character limit, appending a note. */
function truncate(doc: AdfDoc, maxChars: number): AdfDoc {
  let used = 0;
  const content: AdfNode[] = [];
  for (const node of doc.content) {
    const size = JSON.stringify(node).length;
    if (used + size > maxChars) {
      content.push(panel("warning", [
        paragraph(
          text(
            "Content was truncated during migration because it exceeded Jira's length limit. " +
              "See the full version in Azure DevOps.",
          ),
        ),
      ]));
      break;
    }
    used += size;
    content.push(node);
  }
  return { ...doc, content };
}
