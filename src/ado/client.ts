import type { Config } from "../config.ts";
import { basicAuth, HttpError, request, requestJson } from "../util/http.ts";
import { chunk } from "../util/pool.ts";
import { log } from "../log.ts";
import type {
  AdoClassificationNode,
  AdoComment,
  AdoTeam,
  AdoTeamIteration,
  AdoUpdate,
  AdoWorkItem,
} from "./types.ts";

interface Paged<T> {
  count: number;
  value: T[];
}

export interface AdoQuery {
  id: string;
  name: string;
  path: string;
  wiql?: string;
  queryType?: "flat" | "tree" | "oneHop";
  isFolder?: boolean;
}

interface WiqlQueryResult {
  queryType?: "flat" | "tree" | "oneHop";
  workItems?: { id: number }[];
  workItemRelations?: {
    rel: string | null;
    source: { id: number } | null;
    target: { id: number } | null;
  }[];
}

export interface StoredQueryResult {
  name: string;
  path: string;
  queryType: "flat" | "tree" | "oneHop";
  wiql?: string;
  ids: number[];
  /** Only present for tree/oneHop queries: child id -> parent id. */
  parentByChild: Map<number, number>;
}

/**
 * A query referenced by GUID is passed through as-is; a path reference has each
 * segment encoded but keeps `/`, which the API uses for folder nesting.
 */
function encodeQueryRef(idOrPath: string): string {
  const trimmed = idOrPath.trim().replace(/^\/+|\/+$/g, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return trimmed;
  return trimmed.split("/").map(encodeURIComponent).join("/");
}

/** Azure DevOps REST client (api-version is configurable, defaults to 7.1). */
export class AdoClient {
  private readonly auth: string;
  private readonly org: string;
  private readonly project: string;
  private readonly apiVersion: string;
  readonly orgUrl: string;
  readonly projectUrl: string;

  constructor(cfg: Config) {
    // An ADO PAT uses basic auth with an empty username.
    this.auth = basicAuth("", cfg.ado.pat);
    this.org = cfg.ado.org;
    this.project = cfg.ado.project;
    this.apiVersion = cfg.ado.apiVersion;
    this.orgUrl = cfg.ado.baseUrl;
    this.projectUrl = `${cfg.ado.baseUrl}/${encodeURIComponent(cfg.ado.project)}`;
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}, apiVersion?: string) {
    const base = path.startsWith("http") ? path : `${this.orgUrl}${path}`;
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    if (!u.searchParams.has("api-version")) u.searchParams.set("api-version", apiVersion ?? this.apiVersion);
    return u.toString();
  }

  private get<T>(path: string, params?: Record<string, string | number | undefined>, apiVersion?: string) {
    return requestJson<T>(this.url(path, params, apiVersion), {
      headers: { Authorization: this.auth, Accept: "application/json" },
      label: `ADO GET ${path}`,
    });
  }

  private post<T>(
    path: string,
    body: unknown,
    params?: Record<string, string | number | undefined>,
    apiVersion?: string,
  ) {
    return requestJson<T>(this.url(path, params, apiVersion), {
      method: "POST",
      headers: {
        Authorization: this.auth,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      label: `ADO POST ${path}`,
    });
  }

  /** Verify the credentials and that the project exists. Returns the project id. */
  async verifyAccess(): Promise<{ id: string; name: string; description?: string }> {
    try {
      return await this.get<{ id: string; name: string; description?: string }>(
        `/_apis/projects/${encodeURIComponent(this.project)}`,
      );
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 203)) {
        throw new Error("ADO_PAT is invalid or has expired (401/203 from Azure DevOps).");
      }
      if (err instanceof HttpError && err.status === 404) {
        throw new Error(`Project "${this.project}" not found in organization "${this.org}".`);
      }
      throw err;
    }
  }

  /**
   * Fetch every work item id in the project via WIQL.
   * WIQL returns at most 20,000 ids per query, so we page by ascending id.
   */
  async listWorkItemIds(opts: { includeRemoved: boolean; extraFilter: string }): Promise<number[]> {
    const all: number[] = [];
    let lastId = 0;
    const PAGE = 19_000;

    while (true) {
      const clauses = [
        `[System.TeamProject] = @project`,
        `[System.Id] > ${lastId}`,
      ];
      if (!opts.includeRemoved) clauses.push(`[System.State] <> 'Removed'`);
      const filter = opts.extraFilter.trim();
      const query = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")} ${filter} ` +
        `ORDER BY [System.Id] ASC`;

      const res = await this.post<{ workItems: { id: number }[] }>(
        `/${encodeURIComponent(this.project)}/_apis/wit/wiql`,
        { query },
        { "$top": PAGE },
      );
      const ids = (res.workItems ?? []).map((w) => w.id);
      if (!ids.length) break;
      all.push(...ids);
      lastId = ids[ids.length - 1];
      log.debug(`WIQL: +${ids.length} work items (total ${all.length}, lastId=${lastId})`);
      if (ids.length < PAGE) break;
    }
    return all;
  }

  /** The project's saved query tree (My Queries + Shared Queries). */
  async listQueries(depth = 3): Promise<AdoQuery[]> {
    const res = await this.get<Paged<AdoQuery & { children?: AdoQuery[] }>>(
      `/${encodeURIComponent(this.project)}/_apis/wit/queries`,
      { $depth: depth, $expand: "wiql" },
    );
    const out: AdoQuery[] = [];
    const walk = (nodes: (AdoQuery & { children?: AdoQuery[] })[]) => {
      for (const node of nodes) {
        if (!node.isFolder) out.push(node);
        if (node.children?.length) walk(node.children as (AdoQuery & { children?: AdoQuery[] })[]);
      }
    };
    walk(res.value ?? []);
    return out;
  }

  /** Metadata for a saved query, by GUID or by path such as "Shared Queries/Name". */
  async getQuery(idOrPath: string): Promise<AdoQuery> {
    try {
      return await this.get<AdoQuery>(
        `/${encodeURIComponent(this.project)}/_apis/wit/queries/${encodeQueryRef(idOrPath)}`,
        { $expand: "wiql" },
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        throw new Error(
          `Query "${idOrPath}" not found in project ${this.project}.\n` +
            `  - By GUID: the query must be SAVED (URL of the form _queries/query/<guid>). ` +
            `A URL containing "tempQueryId" is a temporary query and cannot be called ` +
            `through the API — click Save query first.\n` +
            `  - By path: for example "Shared Queries/Context Engine/Backlog".`,
        );
      }
      throw err;
    }
  }

  /**
   * Run a saved query and return its work item ids.
   *
   * tree/oneHop queries return `workItemRelations` instead of `workItems`; the
   * Hierarchy-Forward relations in there are the query's parent-child structure.
   */
  async runStoredQuery(idOrPath: string): Promise<StoredQueryResult> {
    const meta = await this.getQuery(idOrPath);
    const res = await this.get<WiqlQueryResult>(
      `/${encodeURIComponent(this.project)}/_apis/wit/wiql/${meta.id}`,
      { $top: 19_000 },
    );

    const ids = new Set<number>();
    const parentByChild = new Map<number, number>();

    for (const w of res.workItems ?? []) ids.add(w.id);
    for (const rel of res.workItemRelations ?? []) {
      if (rel.target?.id) ids.add(rel.target.id);
      if (rel.source?.id) ids.add(rel.source.id);
      if (rel.rel === "System.LinkTypes.Hierarchy-Forward" && rel.source?.id && rel.target?.id) {
        parentByChild.set(rel.target.id, rel.source.id);
      }
    }

    return {
      name: meta.name,
      path: meta.path,
      queryType: res.queryType ?? meta.queryType ?? "flat",
      wiql: meta.wiql,
      ids: [...ids].sort((a, b) => a - b),
      parentByChild,
    };
  }

  /** Fetch work item details in batches of 200, the workitemsbatch limit. */
  async getWorkItems(ids: number[]): Promise<AdoWorkItem[]> {
    const out: AdoWorkItem[] = [];
    for (const batch of chunk(ids, 200)) {
      const res = await this.post<Paged<AdoWorkItem>>(
        `/_apis/wit/workitemsbatch`,
        { ids: batch, $expand: "all", errorPolicy: "omit" },
      );
      out.push(...(res.value ?? []).filter(Boolean));
    }
    return out;
  }

  async getComments(workItemId: number): Promise<AdoComment[]> {
    const out: AdoComment[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.get<{ comments: AdoComment[]; continuationToken?: string }>(
        `/${encodeURIComponent(this.project)}/_apis/wit/workItems/${workItemId}/comments`,
        { $top: 200, continuationToken, includeDeleted: "false", expand: "renderedText" },
        "7.1-preview.4",
      );
      out.push(...(res.comments ?? []));
      continuationToken = res.continuationToken;
    } while (continuationToken);
    return out.sort((a, b) => (a.createdDate ?? "").localeCompare(b.createdDate ?? ""));
  }

  /** Field change history, one entry per revision. */
  async getUpdates(workItemId: number): Promise<AdoUpdate[]> {
    // The updates endpoint caps $top at 200, so page through with $skip.
    const PAGE = 200;
    const out: AdoUpdate[] = [];
    for (let skip = 0;; skip += PAGE) {
      const res = await this.get<Paged<AdoUpdate>>(
        `/${encodeURIComponent(this.project)}/_apis/wit/workItems/${workItemId}/updates`,
        { $top: PAGE, $skip: skip },
      );
      const page = res.value ?? [];
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out;
  }

  async getClassificationNodes(structure: "areas" | "iterations"): Promise<AdoClassificationNode> {
    return await this.get<AdoClassificationNode>(
      `/${encodeURIComponent(this.project)}/_apis/wit/classificationnodes/${structure}`,
      { $depth: 14 },
    );
  }

  async getTeams(): Promise<AdoTeam[]> {
    const res = await this.get<Paged<AdoTeam>>(
      `/_apis/projects/${encodeURIComponent(this.project)}/teams`,
      { $top: 500 },
    );
    return res.value ?? [];
  }

  /** Iterations assigned to a specific team — the most accurate source of sprint dates. */
  async getTeamIterations(teamId: string): Promise<AdoTeamIteration[]> {
    try {
      const res = await this.get<Paged<AdoTeamIteration>>(
        `/${encodeURIComponent(this.project)}/${
          encodeURIComponent(teamId)
        }/_apis/work/teamsettings/iterations`,
      );
      return res.value ?? [];
    } catch (err) {
      // A team with no backlog iteration configured returns 404; not a real error.
      if (err instanceof HttpError && err.status === 404) return [];
      throw err;
    }
  }

  /** Download attachment content. `url` is the absolute URL taken from the relation. */
  async downloadAttachment(url: string): Promise<Uint8Array> {
    const u = new URL(url);
    u.searchParams.set("download", "true");
    if (!u.searchParams.has("api-version")) u.searchParams.set("api-version", this.apiVersion);
    const res = await request(u.toString(), {
      headers: { Authorization: this.auth },
      label: `ADO attachment ${u.pathname}`,
    });
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The work item's web URL (not the API one), for embedding in a Jira description. */
  webUrl(workItemId: number): string {
    return `${this.orgUrl}/${encodeURIComponent(this.project)}/_workitems/edit/${workItemId}`;
  }
}
