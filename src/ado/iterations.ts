import type { AdoClassificationNode, AdoTeamIteration, FlatIteration } from "./types.ts";

/**
 * Flatten the project iteration tree and fill in start/finish dates from team
 * settings, which are more reliable when a parent node carries no attributes.
 *
 * Classification node paths look like `\Project\Iteration\Sprint 1`; they are
 * normalised to `Project\Sprint 1` so they match a work item's
 * `System.IterationPath`.
 */
export function flattenIterations(
  root: AdoClassificationNode,
  teamIterations: AdoTeamIteration[],
): FlatIteration[] {
  const byPath = new Map<string, AdoTeamIteration>();
  for (const it of teamIterations) byPath.set(normalizePath(it.path), it);

  const out: FlatIteration[] = [];
  const walk = (node: AdoClassificationNode, depth: number) => {
    const path = normalizePath(node.path);
    const team = byPath.get(path);
    const start = node.attributes?.startDate ?? team?.attributes?.startDate ?? null;
    const finish = node.attributes?.finishDate ?? team?.attributes?.finishDate ?? null;
    const children = node.children ?? [];

    out.push({
      path,
      name: node.name,
      startDate: start,
      finishDate: finish,
      timeFrame: deriveTimeFrame(start, finish),
      depth,
      isLeaf: children.length === 0,
    });
    for (const child of children) walk(child, depth + 1);
  };
  walk(root, 0);

  // The root iteration shares the project name and is not a real sprint.
  return out.filter((i) => i.depth > 0);
}

/**
 * `System.IterationPath` uses `Project\Sprint 1` while classification nodes use
 * `\Project\Iteration\Sprint 1`. This brings both into the same shape.
 */
export function normalizePath(path: string): string {
  const parts = path.replace(/\//g, "\\").split("\\").filter(Boolean);
  // Drop the "Iteration" / "Area" segment ADO inserts in second position.
  if (parts.length > 1 && (parts[1] === "Iteration" || parts[1] === "Area")) parts.splice(1, 1);
  return parts.join("\\");
}

/** The path below the project name, e.g. `Proj\Team A\Web` -> `Team A\Web`. */
export function stripProject(path: string): string {
  const parts = normalizePath(path).split("\\");
  return parts.slice(1).join("\\");
}

function deriveTimeFrame(start: string | null, finish: string | null): "future" | "current" | "past" {
  const now = Date.now();
  const s = start ? Date.parse(start) : NaN;
  const f = finish ? Date.parse(finish) : NaN;
  if (Number.isFinite(f) && f < now) return "past";
  if (Number.isFinite(s) && s > now) return "future";
  if (Number.isFinite(s) && Number.isFinite(f)) return "current";
  return "future";
}
