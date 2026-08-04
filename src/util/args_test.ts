import assert from "node:assert/strict";
import { parseArgs } from "./args.ts";

const spec = {
  boolean: ["dry-run", "help", "verbose", "resume"],
  string: ["phase", "only", "limit"],
  alias: { h: "help", v: "verbose" },
  defaults: { resume: true },
} as const;

Deno.test("positional plus boolean flag", () => {
  const a = parseArgs(["import", "--dry-run"], spec);
  assert.deepEqual(a._, ["import"]);
  assert.equal(a.flags["dry-run"], true);
});

Deno.test("both --key=value and --key value work", () => {
  assert.equal(parseArgs(["import", "--phase=issues"], spec).values.phase, "issues");
  assert.equal(parseArgs(["import", "--phase", "issues,links"], spec).values.phase, "issues,links");
});

Deno.test("--no-flag inverts the default", () => {
  assert.equal(parseArgs(["export"], spec).flags.resume, true);
  assert.equal(parseArgs(["export", "--no-resume"], spec).flags.resume, false);
});

Deno.test("short aliases", () => {
  const a = parseArgs(["verify", "-v"], spec);
  assert.equal(a.flags.verbose, true);
  const b = parseArgs(["verify", "-vh"], spec);
  assert.equal(b.flags.verbose, true);
  assert.equal(b.flags.help, true);
});

Deno.test("values containing = are not truncated", () => {
  const a = parseArgs(["import", "--only=1,2,3"], spec);
  assert.equal(a.values.only, "1,2,3");
});

Deno.test("undeclared flags are still parsed", () => {
  const a = parseArgs(["import", "--reset-state"], spec);
  assert.equal(a.flags["reset-state"], true);
});
