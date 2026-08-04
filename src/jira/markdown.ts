import { type AdfDoc, type AdfMark, type AdfNode, htmlToAdf, paragraph, text } from "./adf.ts";

/**
 * Markdown → ADF.
 *
 * Needed because an Azure DevOps CSV export mixes two description formats:
 * older items carry HTML from the rich-text editor, newer ones carry Markdown.
 * Pushing Markdown through the HTML converter flattens headings / checklists /
 * tables into plain text — losing exactly the structure long tickets rely on.
 *
 * Supports headings, nested bullet/ordered lists, task lists, tables, code
 * fence, blockquote, rule, bold/italic/code/strike, link, autolink.
 */
export function markdownToAdf(md: string | null | undefined, ctx: MarkdownContext = {}): AdfDoc {
  if (!md || !md.trim()) return { version: 1, type: "doc", content: [] };
  const lines = decodeEntities(md).replace(/\r\n?/g, "\n").split("\n");
  const parser = new BlockParser(lines, ctx);
  return { version: 1, type: "doc", content: parser.parse() };
}

export interface MarkdownContext {
  /** localId prefix for taskItems, shared when several documents are concatenated. */
  idPrefix?: string;
}

/**
 * Pick the converter from the field's actual content.
 *
 * Counts block-level signals for both formats rather than guessing from the
 * first character: ADO descriptions often sprinkle `&nbsp;` and stray inline
 * tags through Markdown prose, so "does it contain HTML tags" misclassifies.
 */
export function richTextToAdf(
  value: string | null | undefined,
  ctx: Parameters<typeof htmlToAdf>[1] = {},
): AdfDoc {
  if (!value || !value.trim()) return { version: 1, type: "doc", content: [] };
  return detectFormat(value) === "html" ? htmlToAdf(value, ctx) : markdownToAdf(value);
}

export function detectFormat(value: string): "html" | "markdown" {
  const html = (value.match(/<\/?(div|p|ul|ol|li|table|tr|td|th|h[1-6]|pre|blockquote)\b/gi) ?? []).length;
  let markdown = 0;
  for (const line of value.split(/\r?\n/)) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) markdown += 2;
    if (/^\s*[-*+]\s+\[[ xX]\]/.test(line)) markdown += 2;
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) markdown++;
    if (/^\s*\|.*\|\s*$/.test(line)) markdown++;
    if (/^\s*```/.test(line)) markdown += 2;
    if (/^\s*>\s/.test(line)) markdown++;
  }
  if (html >= 2) return "html";
  if (markdown >= 2) return "markdown";
  return html > 0 ? "html" : "markdown";
}

/* ── Block parser ────────────────────────────────────────────────────────── */

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(```|~~~)\s*([\w+#-]*)\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s*(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

class BlockParser {
  private i = 0;
  private taskSeq = 0;

  constructor(private lines: string[], private ctx: MarkdownContext) {}

  parse(): AdfNode[] {
    const out: AdfNode[] = [];
    while (this.i < this.lines.length) {
      const node = this.block();
      if (node) out.push(...node);
    }
    return out;
  }

  private localId(): string {
    return `${this.ctx.idPrefix ?? "t"}-${++this.taskSeq}`;
  }

  private block(): AdfNode[] | null {
    const line = this.lines[this.i];

    if (!line.trim()) {
      this.i++;
      return null;
    }

    const fence = FENCE.exec(line);
    if (fence) return this.codeFence(fence[1], fence[2]);

    if (RULE.test(line)) {
      this.i++;
      return [{ type: "rule" }];
    }

    const heading = HEADING.exec(line);
    if (heading) {
      this.i++;
      const content = inline(heading[2]);
      return content.length ? [{ type: "heading", attrs: { level: heading[1].length }, content }] : [];
    }

    if (QUOTE.test(line)) return this.blockquote();

    if (this.isTableStart()) return this.table();

    if (BULLET.test(line) || ORDERED.test(line)) return this.list(indentOf(line));

    return this.paragraph();
  }

  private codeFence(marker: string, language: string): AdfNode[] {
    this.i++;
    const body: string[] = [];
    while (this.i < this.lines.length && !this.lines[this.i].trimStart().startsWith(marker)) {
      body.push(this.lines[this.i++]);
    }
    if (this.i < this.lines.length) this.i++; // closing fence
    const code = body.join("\n").replace(/\s+$/, "");
    if (!code) return [];
    return [{
      type: "codeBlock",
      attrs: language ? { language: language.toLowerCase() } : {},
      content: [{ type: "text", text: code }],
    }];
  }

  private blockquote(): AdfNode[] {
    const body: string[] = [];
    while (this.i < this.lines.length) {
      const m = QUOTE.exec(this.lines[this.i]);
      if (!m) break;
      body.push(m[1]);
      this.i++;
    }
    const inner = new BlockParser(body, this.ctx).parse()
      .filter((n) => ["paragraph", "bulletList", "orderedList", "codeBlock", "heading"].includes(n.type));
    return inner.length ? [{ type: "blockquote", content: inner }] : [];
  }

  private isTableStart(): boolean {
    return TABLE_ROW.test(this.lines[this.i]) && TABLE_SEP.test(this.lines[this.i + 1] ?? "");
  }

  private table(): AdfNode[] {
    const headerCells = splitRow(this.lines[this.i]);
    this.i += 2; // skip the header row and the separator row

    const rows: AdfNode[] = [{
      type: "tableRow",
      content: headerCells.map((c) => cell("tableHeader", c)),
    }];

    while (this.i < this.lines.length && TABLE_ROW.test(this.lines[this.i])) {
      const cells = splitRow(this.lines[this.i]);
      this.i++;
      // Normalise to the header's column count — Jira rejects ragged tables.
      while (cells.length < headerCells.length) cells.push("");
      rows.push({
        type: "tableRow",
        content: cells.slice(0, headerCells.length).map((c) => cell("tableCell", c)),
      });
    }

    return [{ type: "table", attrs: { isNumberColumnEnabled: false, layout: "default" }, content: rows }];
  }

  /** A list (task list included) starting at indent level `baseIndent`. */
  private list(baseIndent: number): AdfNode[] {
    const first = this.lines[this.i];
    const ordered = ORDERED.test(first) && !BULLET.test(first);
    const items: AdfNode[] = [];
    let isTaskList = false;

    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (!line.trim()) {
        // Blank line: only continue if the next line still belongs to this list.
        const next = this.lines[this.i + 1] ?? "";
        if (!next.trim() || indentOf(next) < baseIndent || !(BULLET.test(next) || ORDERED.test(next))) break;
        this.i++;
        continue;
      }

      const indent = indentOf(line);
      if (indent < baseIndent) break;

      const bullet = BULLET.exec(line);
      const order = ORDERED.exec(line);
      if (!bullet && !order) break;
      if (indent > baseIndent) break; // nested list — handled while collecting the item

      const isOrdered = Boolean(order) && !bullet;
      if (isOrdered !== ordered) break; // list type changed -> end the current list

      this.i++;
      let body = bullet ? bullet[2] : order![3];

      const task = TASK.exec(body);
      const checked = task ? task[1].toLowerCase() === "x" : null;
      if (task) {
        isTaskList = true;
        body = task[2];
      }

      // Collect following lines belonging to this item: deeper indent, or a lazy continuation.
      const continuation: string[] = [];
      while (this.i < this.lines.length) {
        const next = this.lines[this.i];
        if (!next.trim()) break;
        const nextIndent = indentOf(next);
        if (nextIndent > baseIndent) {
          continuation.push(next.slice(Math.min(nextIndent, baseIndent + 2)));
          this.i++;
          continue;
        }
        if (!BULLET.test(next) && !ORDERED.test(next) && nextIndent >= baseIndent) {
          continuation.push(next.trim());
          this.i++;
          continue;
        }
        break;
      }

      const inlineContent = inline(body);
      if (checked !== null) {
        items.push({
          type: "taskItem",
          attrs: { localId: this.localId(), state: checked ? "DONE" : "TODO" },
          content: inlineContent,
        });
        continue;
      }

      const content: AdfNode[] = [paragraph(...inlineContent)];
      if (continuation.length) {
        content.push(...new BlockParser(continuation, this.ctx).parse());
      }
      items.push({ type: "listItem", content });
    }

    if (!items.length) return [];
    if (isTaskList) {
      // taskItem and listItem cannot mix — put non-task entries in their own list.
      const tasks = items.filter((n) => n.type === "taskItem");
      const rest = items.filter((n) => n.type !== "taskItem");
      const out: AdfNode[] = [{ type: "taskList", attrs: { localId: this.localId() }, content: tasks }];
      if (rest.length) out.push({ type: "bulletList", content: rest });
      return out;
    }
    return [{ type: ordered ? "orderedList" : "bulletList", content: items }];
  }

  private paragraph(): AdfNode[] {
    const buffer: string[] = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (!line.trim()) break;
      if (HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line)) break;
      if (BULLET.test(line) || ORDERED.test(line)) break;
      if (this.isTableStart()) break;
      buffer.push(line.trim());
      this.i++;
    }
    if (!buffer.length) return [];

    const content: AdfNode[] = [];
    buffer.forEach((line, index) => {
      if (index > 0) content.push({ type: "hardBreak" });
      content.push(...inline(line));
    });
    return content.length ? [{ type: "paragraph", content }] : [];
  }
}

function cell(type: "tableHeader" | "tableCell", value: string): AdfNode {
  const content = inline(value);
  return { type, attrs: {}, content: content.length ? [paragraph(...content)] : [paragraph()] };
}

function splitRow(line: string): string[] {
  const inner = TABLE_ROW.exec(line)?.[1] ?? "";
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else current += inner[i];
  }
  cells.push(current.trim());
  return cells;
}

const indentOf = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, "    ").length;

/* ── Inline parser ───────────────────────────────────────────────────────── */

const INLINE_PATTERNS: { re: RegExp; mark?: AdfMark; kind?: "code" | "link" | "autolink" | "escape" }[] = [
  // Escapes must be checked first so `\*` does not turn on italics.
  // Only ASCII punctuation is escapable, which keeps Windows paths such as
  // `C:\src\python.exe` with their backslashes intact.
  { re: /\\([!-/:-@[-`{-~])/, kind: "escape" },
  { re: /`([^`]+)`/, kind: "code" },
  { re: /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, kind: "link" },
  { re: /<((?:https?|mailto):[^>\s]+)>/, kind: "autolink" },
  { re: /\*\*\*([^*]+)\*\*\*/, mark: { type: "strong" } },
  { re: /\*\*([^*]+)\*\*/, mark: { type: "strong" } },
  { re: /__([^_]+)__/, mark: { type: "strong" } },
  { re: /~~([^~]+)~~/, mark: { type: "strike" } },
  { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/, mark: { type: "em" } },
  { re: /(?<![\w_])_([^_\n]+)_(?![\w_])/, mark: { type: "em" } },
];

const BARE_URL = /(?<![("<\w])(https?:\/\/[^\s<>()"'\]]+[^\s<>()"'\].,;:!?])/;

/** Convert one line of markdown into ADF inline nodes. */
export function inline(value: string, marks: AdfMark[] = []): AdfNode[] {
  if (!value) return [];

  let best: { index: number; match: RegExpExecArray; spec: (typeof INLINE_PATTERNS)[number] } | null = null;
  for (const spec of INLINE_PATTERNS) {
    const match = spec.re.exec(value);
    if (match && (best === null || match.index < best.index)) best = { index: match.index, match, spec };
  }

  const url = BARE_URL.exec(value);
  if (url && (best === null || url.index < best.index)) {
    return [
      ...inline(value.slice(0, url.index), marks),
      text(url[1], dedupe([...marks, { type: "link", attrs: { href: url[1] } }])),
      ...inline(value.slice(url.index + url[1].length), marks),
    ];
  }

  if (!best) return value ? [text(value, marks.length ? marks : undefined)] : [];

  const { match, spec } = best;
  const before = inline(value.slice(0, match.index), marks);
  const after = inline(value.slice(match.index + match[0].length), marks);

  let middle: AdfNode[];
  if (spec.kind === "escape") {
    middle = [text(match[1], marks.length ? marks : undefined)];
  } else if (spec.kind === "code") {
    middle = [text(match[1], dedupe([...marks, { type: "code" }]))];
  } else if (spec.kind === "link") {
    const href = normalizeHref(match[2]);
    const label = match[1] || match[2];
    middle = href
      ? inline(label, dedupe([...marks, { type: "link", attrs: { href } }]))
      : inline(label, marks);
    if (!middle.length) middle = [text(label, marks.length ? marks : undefined)];
  } else if (spec.kind === "autolink") {
    middle = [text(match[1], dedupe([...marks, { type: "link", attrs: { href: match[1] } }]))];
  } else {
    middle = inline(match[1], dedupe([...marks, spec.mark!]));
  }

  return [...before, ...middle, ...after];
}

function dedupe(marks: AdfMark[]): AdfMark[] {
  const seen = new Map<string, AdfMark>();
  for (const m of marks) seen.set(m.type, m);
  const list = [...seen.values()];
  // `code` does not combine with other formatting marks in ADF.
  return list.some((m) => m.type === "code")
    ? list.filter((m) => m.type === "code" || m.type === "link")
    : list;
}

function normalizeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?|mailto|ftp):/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
