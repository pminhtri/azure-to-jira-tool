#!/usr/bin/env -S deno run -A
import { parseArgs } from "./util/args.ts";
import { loadConfig } from "./config.ts";
import { log, setVerbose } from "./log.ts";
import { runExport } from "./ado/export.ts";
import { type DateOrder, runCsvImport } from "./ado/csv.ts";
import { Importer, type Phase, PHASES } from "./jira/import.ts";
import { runFields, runPlan, runQueries, runVerify, runWhoami } from "./commands.ts";
import { Store } from "./util/state.ts";
import { HttpError } from "./util/http.ts";

const HELP = `
Migrate Azure DevOps → Jira (Cloud or Server / Data Center)

  deno task queries              List saved ADO queries with their GUIDs
  deno task export [options]     Download all ADO data into DATA_DIR via the REST API
  deno task csv <a.csv> [b.csv]  Load data from an ADO CSV export into DATA_DIR
                                 (files merge by ID; later files win on conflict)
  deno task plan                 Analyse the exported data and preview the mapping
  deno task whoami               Test the Jira connection and credentials only
  deno task fields               Print Jira metadata (issue types / statuses / fields / boards)
  deno task import [options]     Push data into Jira (idempotent and resumable)
  deno task verify               Reconcile ADO against Jira after the migration

Options
  --dry-run              Write nothing to Jira, just print what would happen
  --phase=<a,b,...>      Run only the named phases (default: all)
                         ${PHASES.join(", ")}
  --only=<id,id,...>     Process only these ADO work item ids
  --limit=<n>            Cap the number of work items (smoke test)
  --no-resume            (export) re-download work items already on disk
  --date-order=<v>       (csv) month-first | day-first, inferred by default
  --query=<id|path>      (export) run a saved ADO query instead of scanning the project
  --config=<path>        Path to migration.config.json (default ./migration.config.json)
  --reset-state          Delete the state file first (does NOT delete issues in Jira)
  --verbose, -v          Verbose logging
  --help, -h             Show this help

Recommended workflow
  1. cp .env.example .env  &&  fill in the credentials
  2. deno task export
  3. deno task fields          -> update "fields" in migration.config.json
  4. deno task plan            -> review the issue type / status mapping
  5. deno task import --limit=20 --dry-run
  6. deno task import --limit=20      -> inspect the result in Jira by hand
  7. deno task import                 -> run the whole migration
  8. deno task verify
`;

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    boolean: ["dry-run", "help", "verbose", "resume", "reset-state"],
    string: ["phase", "only", "limit", "config", "date-order", "query"],
    alias: { h: "help", v: "verbose" },
    defaults: { resume: true },
  });

  const command = args._[0] ?? "";
  if (args.flags.help || !command) {
    console.log(HELP);
    return args.flags.help ? 0 : 1;
  }
  setVerbose(args.flags.verbose === true);

  const cfg = await loadConfig(args.values.config ?? "migration.config.json");
  const only = args.values.only
    ? args.values.only.split(",").map((s) => Number(s.trim())).filter(Number.isFinite)
    : undefined;
  const limit = args.values.limit ? Number(args.values.limit) : undefined;

  // `whoami` deliberately works without a target project; everything else needs one.
  if (["fields", "import", "verify"].includes(command) && !cfg.jira.projectKey) {
    log.error(
      "JIRA_PROJECT_KEY is not set in .env. Run `deno task whoami` to verify the " +
        "connection first, then set the key of the target project.",
    );
    return 1;
  }

  switch (command) {
    case "export": {
      await runExport(cfg, {
        resume: args.flags.resume !== false,
        only,
        limit,
        query: args.values.query,
      });
      return 0;
    }

    case "queries":
      await runQueries(cfg);
      return 0;

    case "csv": {
      const files = args._.slice(1);
      if (!files.length) {
        log.error("Missing file path. Example: deno task csv ./data.csv [./more.csv ...]");
        return 1;
      }
      const dateOrder = args.values["date-order"];
      if (dateOrder && dateOrder !== "month-first" && dateOrder !== "day-first") {
        log.error(`--date-order must be "month-first" or "day-first" (got: ${dateOrder})`);
        return 1;
      }
      await runCsvImport(cfg, { files, dateOrder: dateOrder as DateOrder | undefined, limit });
      return 0;
    }

    case "plan":
      await runPlan(cfg);
      return 0;

    case "whoami":
      await runWhoami(cfg);
      return 0;

    case "fields":
      await runFields(cfg);
      return 0;

    case "verify":
      await runVerify(cfg);
      return 0;

    case "import": {
      const phases = parsePhases(args.values.phase);
      if (args.flags["reset-state"]) {
        const path = `${cfg.stateDir}/${cfg.jira.projectKey}.state.json`;
        await Deno.remove(path).catch(() => {});
        log.warn(
          `Deleted ${path}. Issues already created in Jira are NOT removed — re-running may duplicate them.`,
        );
      }
      const store = await Store.open(cfg.stateDir, cfg.jira.projectKey);
      const importer = new Importer(cfg, store, {
        dryRun: args.flags["dry-run"] === true,
        phases,
        only,
        limit,
      });
      try {
        await importer.run();
      } finally {
        await store.close();
      }
      return 0;
    }

    default:
      log.error(`Unknown command: "${command}"`);
      console.log(HELP);
      return 1;
  }
}

function parsePhases(value: string | undefined): Phase[] {
  if (!value) return [...PHASES];
  const requested = value.split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = requested.filter((p) => !PHASES.includes(p as Phase));
  if (invalid.length) {
    throw new Error(`Invalid phase: ${invalid.join(", ")}\nValid phases: ${PHASES.join(", ")}`);
  }
  return requested as Phase[];
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err) {
    if (err instanceof HttpError) {
      log.error(`${err.message.split("\n")[0]}\n   ${err.detail}`);
    } else {
      log.error((err as Error)?.message ?? String(err));
      if (Deno.args.includes("-v") || Deno.args.includes("--verbose")) console.error(err);
    }
    Deno.exit(1);
  }
}
