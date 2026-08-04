/** Minimal filesystem helpers — replaces @std/fs. */

export async function ensureDir(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/** Write JSON via a temp file then rename, so an interrupted run cannot corrupt it. */
export async function writeJsonAtomic(path: string, value: unknown, pretty = true): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(value, null, pretty ? 2 : undefined));
  await Deno.rename(tmp, path);
}
