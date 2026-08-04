import { blue, bold, cyan, dim, green, red, yellow } from "./util/colors.ts";

let verbose = false;
export function setVerbose(v: boolean) {
  verbose = v;
}

const ts = () => dim(new Date().toISOString().slice(11, 19));

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`${ts()} ${msg}`, ...rest),
  step: (msg: string) => console.log(`${ts()} ${bold(blue("▶"))} ${bold(msg)}`),
  ok: (msg: string, ...rest: unknown[]) => console.log(`${ts()} ${green("✔")} ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`${ts()} ${yellow("⚠")} ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`${ts()} ${red("✖")} ${msg}`, ...rest),
  skip: (msg: string) => verbose && console.log(`${ts()} ${dim("·")} ${dim(msg)}`),
  debug: (msg: string, ...rest: unknown[]) => verbose && console.log(`${ts()} ${dim(msg)}`, ...rest),
  header: (msg: string) =>
    console.log(`\n${bold(cyan("━━ " + msg + " " + "━".repeat(Math.max(0, 60 - msg.length))))}`),
};

/** In-place progress counter rendered on a single terminal line. */
export class Progress {
  private done = 0;
  private failed = 0;
  private lastRender = 0;

  constructor(private label: string, private total: number) {}

  tick(ok = true) {
    this.done++;
    if (!ok) this.failed++;
    const now = Date.now();
    if (now - this.lastRender < 120 && this.done < this.total) return;
    this.lastRender = now;
    this.render();
  }

  private render() {
    const pct = this.total ? Math.floor((this.done / this.total) * 100) : 100;
    const width = 24;
    const filled = Math.round((pct / 100) * width);
    const bar = "█".repeat(filled) + dim("░".repeat(width - filled));
    const fail = this.failed ? red(` ${this.failed} failed`) : "";
    const line = `${ts()} ${this.label} ${bar} ${this.done}/${this.total} (${pct}%)${fail}`;
    Deno.stdout.writeSync(new TextEncoder().encode("\r\x1b[2K" + line));
  }

  finish() {
    this.render();
    Deno.stdout.writeSync(new TextEncoder().encode("\n"));
  }
}
