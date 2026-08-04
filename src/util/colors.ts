/**
 * Minimal ANSI color helper — replaces @std/fmt/colors so the project does not
 * depend on the JSR registry, which is blocked on some corporate networks.
 */
const enabled = !Deno.env.get("NO_COLOR") && Deno.stdout.isTerminal?.() !== false;

const wrap = (open: number, close: number) => (s: string) => enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);
