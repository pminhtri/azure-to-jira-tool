import type { AdfDoc, AdfMark, AdfNode } from "./adf.ts";

/**
 * ADF → Jira wiki markup.
 *
 * Jira Server / Data Center does not understand ADF; descriptions and comments
 * must be wiki markup. Rather than writing two more converters (HTML->wiki and
 * Markdown->wiki), the pipeline keeps HTML/Markdown -> ADF and renders down to
 * wiki here, so all existing parsing logic and tests serve both Jira flavours.
 */
export function adfToWiki(doc: AdfDoc | null | undefined): string {
  if (!doc?.content?.length) return "";
  return blocks(doc.content).trim();
}

function blocks(nodes: AdfNode[], listDepth = 0): string {
  return nodes.map((n) => block(n, listDepth)).filter((s) => s !== "").join("\n\n");
}

function block(node: AdfNode, listDepth: number): string {
  switch (node.type) {
    case "paragraph":
      return inlines(node.content ?? []);

    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      const text = inlines(node.content ?? []);
      return text ? `h${level}. ${text}` : "";
    }

    case "rule":
      return "----";

    case "bulletList":
      return listItems(node, listDepth, "*");

    case "orderedList":
      return listItems(node, listDepth, "#");

    case "taskList":
      // Wiki markup has no checkboxes; Unicode boxes read better than the (/) (x)
      // emoticons, which render as a green tick / red X and suggest pass/fail.
      return (node.content ?? [])
        .filter((i) => i.type === "taskItem")
        .map((i) => {
          const mark = i.attrs?.state === "DONE" ? "☑" : "☐";
          return `${"*".repeat(listDepth + 1)} ${mark} ${inlines(i.content ?? [])}`;
        })
        .join("\n");

    case "codeBlock": {
      const code = (node.content ?? []).map((c) => c.text ?? "").join("");
      if (!code.trim()) return "";
      const lang = node.attrs?.language ? `:${node.attrs.language}` : "";
      return `{code${lang}}\n${code}\n{code}`;
    }

    case "blockquote": {
      const inner = blocks(node.content ?? [], listDepth);
      return inner ? `{quote}\n${inner}\n{quote}` : "";
    }

    case "panel": {
      const inner = blocks(node.content ?? [], listDepth);
      if (!inner) return "";
      return `{${PANEL_MACRO[String(node.attrs?.panelType ?? "info")] ?? "info"}}\n${inner}\n{${
        PANEL_MACRO[String(node.attrs?.panelType ?? "info")] ?? "info"
      }}`;
    }

    case "table":
      return table(node);

    case "mediaSingle":
      return blocks(node.content ?? [], listDepth);

    case "media": {
      const name = node.attrs?.alt ?? node.attrs?.id;
      return name ? `!${name}!` : "";
    }

    default:
      // Unknown node: salvage its text rather than dropping the content.
      return node.content ? blocks(node.content, listDepth) : escapeText(node.text ?? "");
  }
}

const PANEL_MACRO: Record<string, string> = {
  info: "info",
  note: "note",
  warning: "warning",
  error: "warning",
  success: "tip",
};

/** A listItem may hold child blocks; wiki expresses nesting by repeating the marker. */
function listItems(node: AdfNode, depth: number, marker: string): string {
  const prefix = marker.repeat(depth + 1);
  const lines: string[] = [];

  for (const item of node.content ?? []) {
    if (item.type !== "listItem") continue;
    const children = item.content ?? [];
    const [first, ...rest] = children;

    const head = first ? block(first, depth) : "";
    lines.push(`${prefix} ${head}`.trimEnd());

    for (const child of rest) {
      if (child.type === "bulletList" || child.type === "orderedList" || child.type === "taskList") {
        const nested = block(child, depth + 1);
        if (nested) lines.push(nested);
      } else {
        // Other blocks inside a listItem (a second paragraph, code…) cannot nest
        // in wiki markup, so emit them as their own line at the same indent.
        const extra = block(child, depth);
        if (extra) lines.push(`${prefix} ${extra}`);
      }
    }
  }
  return lines.join("\n");
}

function table(node: AdfNode): string {
  const rows: string[] = [];
  for (const row of node.content ?? []) {
    if (row.type !== "tableRow") continue;
    const cells = row.content ?? [];
    const isHeader = cells.every((c) => c.type === "tableHeader");
    const sep = isHeader ? "||" : "|";
    const rendered = cells.map((c) => cellText(c));
    rows.push(`${sep}${rendered.join(sep)}${sep}`);
  }
  return rows.join("\n");
}

/** Table cells must not contain newlines or a bare `|`; both break the table. */
function cellText(cell: AdfNode): string {
  const text = blocks(cell.content ?? [])
    .replace(/\n{2,}/g, " \\\\ ")
    .replace(/\n/g, " \\\\ ")
    .trim();
  return text ? ` ${text} ` : " ";
}

/* ── Inline ──────────────────────────────────────────────────────────────── */

function inlines(nodes: AdfNode[]): string {
  return nodes.map(inline).join("");
}

function inline(node: AdfNode): string {
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mediaSingle" || node.type === "media") return block(node, 0);
  if (node.type !== "text") return node.content ? inlines(node.content) : "";

  let text = escapeText(node.text ?? "");
  if (!text) return "";

  const marks = node.marks ?? [];
  const link = marks.find((m) => m.type === "link");

  // Wiki cannot nest formatting inside a link, so apply text marks first, then wrap.
  for (const mark of marks) {
    if (mark.type === "link") continue;
    text = applyMark(text, mark);
  }
  if (link) {
    const href = String(link.attrs?.href ?? "");
    // `[text|url]`; when the text equals the url, plain `[url]` is tidier.
    text = href && href !== text ? `[${text}|${href}]` : `[${href || text}]`;
  }
  return text;
}

function applyMark(text: string, mark: AdfMark): string {
  switch (mark.type) {
    case "strong":
      return `*${text}*`;
    case "em":
      return `_${text}_`;
    case "strike":
      return `-${text}-`;
    case "underline":
      return `+${text}+`;
    case "code":
      return `{{${text}}}`;
    case "subsup":
      return mark.attrs?.type === "sup" ? `^${text}^` : `~${text}~`;
    default:
      return text;
  }
}

/**
 * Escape characters that break wiki structure. Deliberately does NOT escape
 * `*_-+`, which are only meaningful at word boundaries; escaping them all would
 * scatter backslashes through ordinary prose.
 */
function escapeText(text: string): string {
  return text
    .replace(/([\\{}[\]|])/g, "\\$1")
    // `!` hugging text on both sides is read as an image embed.
    .replace(/!(\S+)!/g, "\\!$1\\!");
}
