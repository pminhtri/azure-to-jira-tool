import { resolve } from "node:path";
import { loadEnv } from "./util/dotenv.ts";
import { log } from "./log.ts";

export interface MigrationOptions {
  includeComments: boolean;
  includeHistory: boolean;
  includeAttachments: boolean;
  includeSprints: boolean;
  includeRank: boolean;
  includeLinks: boolean;
  includeRemovedWorkItems: boolean;
  closeCompletedSprints: boolean;
  /** "link": inline images become attachment links. "media": embed an ADF media node (experimental). */
  inlineImageMode: "link" | "media";
  /** Prepend a "Migrated from Azure DevOps #123" panel to the description. */
  descriptionHeader: boolean;
  /** Append a table of ADO fields that have no matching Jira field. */
  descriptionExtraFields: boolean;
  /** Prefix each migrated comment with the original ADO author and date. */
  commentAttribution: boolean;
  /** Extra WIQL clause, e.g. "AND [System.AreaPath] UNDER 'Proj\\Team A'". */
  wiqlFilter: string;
}

export interface LinkTypeMapping {
  name: string;
  direction: "inward" | "outward";
}

export interface JiraFieldIds {
  storyPoints: string | null;
  sprint: string | null;
  epicLink: string | null;
  // Server / Data Center requires "Epic Name" to create an Epic issue.
  epicName: string | null;
  adoId: string | null;
  adoUrl: string | null;
  originalEstimate: string | null;
  startDate: string | null;
}

export interface MappingConfig {
  options: MigrationOptions;
  issueType: Record<string, string>;
  status: Record<string, string>;
  priority: Record<string, string>;
  linkType: Record<string, LinkTypeMapping>;
  fields: JiraFieldIds;
  labels: {
    fromTags: boolean;
    fromAreaPath: boolean;
    /** Add the original ADO work item type as a label, preserving Epic vs Feature. */
    fromWorkItemType: boolean;
    areaPathPrefix: string;
    workItemTypePrefix: string;
    extra: string[];
  };
  /** Sprint dates for the CSV source, which carries no iteration dates. */
  sprintDates: Record<string, { start?: string; end?: string }>;
  components: { fromAreaPath: boolean; map: Record<string, string> };
  users: { autoLookup: boolean; fallbackToUnassigned: boolean; map: Record<string, string> };
}

export interface Config {
  ado: { org: string; project: string; pat: string; apiVersion: string; baseUrl: string };
  jira: {
    baseUrl: string;
    email: string;
    apiToken: string;
    projectKey: string;
    boardName: string | null;
    /** "auto" asks /serverInfo during preflight. */
    deployment: "auto" | "cloud" | "server";
    /** "auto" picks Basic when an email is set, Bearer when only a token is (Server/DC PAT). */
    authScheme: "auto" | "basic" | "bearer";
  };
  concurrency: number;
  maxAttachmentBytes: number;
  dataDir: string;
  stateDir: string;
  mapping: MappingConfig;
}

const DEFAULT_OPTIONS: MigrationOptions = {
  includeComments: true,
  includeHistory: true,
  includeAttachments: true,
  includeSprints: true,
  includeRank: true,
  includeLinks: true,
  includeRemovedWorkItems: false,
  closeCompletedSprints: true,
  inlineImageMode: "link",
  descriptionHeader: true,
  descriptionExtraFields: true,
  commentAttribution: true,
  wiqlFilter: "",
};

const DEFAULT_FIELDS: JiraFieldIds = {
  storyPoints: null,
  sprint: null,
  epicLink: null,
  epicName: null,
  adoId: null,
  adoUrl: null,
  originalEstimate: null,
  startDate: null,
};

/** Read an environment variable constrained to a fixed set of values. */
function pickEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = Deno.env.get(key)?.trim().toLowerCase();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${key} must be one of: ${allowed.join(", ")} (got "${raw}")`);
}

function env(key: string, fallback?: string): string {
  const v = Deno.env.get(key)?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing environment variable ${key}. Copy .env.example to .env and fill it in.`);
}

/** Load .env plus migration.config.json, validate, and return a normalised config. */
export async function loadConfig(configPath = "migration.config.json"): Promise<Config> {
  await loadEnv(".env");

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await Deno.readTextFile(configPath));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    log.warn(`${configPath} not found, falling back to the default mapping.`);
  }

  const mapping: MappingConfig = {
    options: { ...DEFAULT_OPTIONS, ...(raw.options as Partial<MigrationOptions> ?? {}) },
    issueType: strip(raw.issueType) ?? { _default: "Task" },
    status: strip(raw.status) ?? { _default: "To Do" },
    priority: strip(raw.priority) ?? { _default: "Medium" },
    linkType: (strip(raw.linkType) ?? {}) as unknown as Record<string, LinkTypeMapping>,
    fields: { ...DEFAULT_FIELDS, ...(strip(raw.fields) as Partial<JiraFieldIds> ?? {}) },
    labels: {
      fromTags: true,
      fromAreaPath: true,
      fromWorkItemType: false,
      areaPathPrefix: "area-",
      workItemTypePrefix: "ado-",
      extra: [],
      ...(strip(raw.labels) as object ?? {}),
    },
    sprintDates: (strip(raw.sprintDates) ?? {}) as unknown as MappingConfig["sprintDates"],
    components: { fromAreaPath: false, map: {}, ...(strip(raw.components) as object ?? {}) },
    users: {
      autoLookup: true,
      fallbackToUnassigned: true,
      map: {},
      ...(strip(raw.users) as object ?? {}),
    },
  };

  const org = env("ADO_ORG");
  const jiraBase = env("JIRA_BASE_URL").replace(/\/+$/, "");
  // Allows pointing at an on-prem Azure DevOps Server (or a mock server in tests).
  const adoBase = (Deno.env.get("ADO_BASE_URL")?.trim() || `https://dev.azure.com/${encodeURIComponent(org)}`)
    .replace(/\/+$/, "");

  const cfg: Config = {
    ado: {
      org,
      project: env("ADO_PROJECT"),
      pat: env("ADO_PAT"),
      apiVersion: env("ADO_API_VERSION", "7.1"),
      baseUrl: adoBase,
    },
    jira: {
      baseUrl: jiraBase,
      // Server/DC uses a Bearer PAT and needs no email.
      email: Deno.env.get("JIRA_EMAIL")?.trim() ?? "",
      apiToken: env("JIRA_API_TOKEN"),
      // Not required for `whoami`, which tests credentials before a target is chosen.
      projectKey: (Deno.env.get("JIRA_PROJECT_KEY")?.trim() ?? "").toUpperCase(),
      boardName: Deno.env.get("JIRA_BOARD_NAME")?.trim() || null,
      deployment: pickEnum("JIRA_DEPLOYMENT", ["auto", "cloud", "server"], "auto"),
      authScheme: pickEnum("JIRA_AUTH", ["auto", "basic", "bearer"], "auto"),
    },
    concurrency: Math.max(1, Number(env("CONCURRENCY", "4"))),
    maxAttachmentBytes: Number(env("MAX_ATTACHMENT_MB", "10")) * 1024 * 1024,
    dataDir: resolve(env("DATA_DIR", ".data")),
    stateDir: resolve(env("STATE_DIR", ".state")),
    mapping,
  };

  for (const [name, value] of [["JIRA_BASE_URL", cfg.jira.baseUrl], ["ADO_BASE_URL", cfg.ado.baseUrl]]) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} is not a valid URL: "${value}"`);
    }
    if (parsed.protocol === "https:") continue;
    if (parsed.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)) continue;
    if (parsed.protocol === "http:") {
      log.warn(`${name} uses http:// — credentials will travel unencrypted.`);
      continue;
    }
    throw new Error(`${name} must use http(s):// (got: ${value})`);
  }
  return cfg;
}

/** Strip `$comment` metadata keys out of a config object. */
function strip(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, never> = {};
  for (const [k, v] of Object.entries(value as Record<string, never>)) {
    if (k.startsWith("$")) continue;
    out[k] = v;
  }
  return out as unknown as Record<string, string>;
}

/** Look up a mapping table with `_default` support, case-insensitively. */
export function mapValue(table: Record<string, string>, key: string | undefined | null): string | undefined {
  if (key != null) {
    if (table[key] !== undefined) return table[key];
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(table)) {
      if (k.toLowerCase() === lower) return v;
    }
  }
  return table._default;
}
