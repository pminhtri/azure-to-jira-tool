/**
 * Minimal `.env` loader — replaces @std/dotenv.
 * Supports `#` comments, `export KEY=...`, single/double quotes, and `\n` escapes
 * inside double quotes. Variables already present in the process always win.
 */
export async function loadEnv(path = ".env"): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }

  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;

    let value = rawValue.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      value = value.split(" #")[0].trim();
    }

    parsed[key] = value;
    if (Deno.env.get(key) === undefined) Deno.env.set(key, value);
  }
  return parsed;
}
