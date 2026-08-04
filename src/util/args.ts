export interface ParsedArgs {
  _: string[];
  flags: Record<string, boolean>;
  values: Record<string, string>;
}

export interface ArgSpec {
  boolean?: readonly string[];
  string?: readonly string[];
  alias?: Record<string, string>;
  /** Default values for boolean flags (e.g. resume: true enables --no-resume). */
  defaults?: Record<string, boolean>;
}

/**
 * Minimal CLI parser — replaces @std/cli/parse-args.
 * Supports `--flag`, `--no-flag`, `--key=value`, `--key value`, `-v`, and positionals.
 */
export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const booleans = new Set(spec.boolean ?? []);
  const strings = new Set(spec.string ?? []);
  const alias = spec.alias ?? {};
  const out: ParsedArgs = { _: [], flags: { ...(spec.defaults ?? {}) }, values: {} };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      out._.push(arg);
      continue;
    }

    const isLong = arg.startsWith("--");
    let name = arg.replace(/^--?/, "");
    let inline: string | undefined;

    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (!isLong && name.length > 1 && inline === undefined) {
      // Bundled short flags such as -vh
      for (const ch of name) {
        const resolved = alias[ch] ?? ch;
        out.flags[resolved] = true;
      }
      continue;
    }

    if (isLong && name.startsWith("no-") && booleans.has(name.slice(3))) {
      out.flags[name.slice(3)] = false;
      continue;
    }

    const key = alias[name] ?? name;

    if (strings.has(key)) {
      out.values[key] = inline ?? argv[++i] ?? "";
      continue;
    }
    if (booleans.has(key) || inline === undefined) {
      out.flags[key] = inline === undefined ? true : inline !== "false" && inline !== "0";
      continue;
    }
    out.values[key] = inline;
  }
  return out;
}
