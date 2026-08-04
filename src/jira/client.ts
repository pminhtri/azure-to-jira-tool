import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { basicAuth, HttpError, request, requestJson } from "../util/http.ts";
import { adfToWiki } from "./wiki.ts";
import { chunk } from "../util/pool.ts";
import type { AdfDoc } from "./adf.ts";

export interface JiraField {
  id: string;
  key: string;
  name: string;
  custom: boolean;
  schema?: { type: string; custom?: string; system?: string };
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
  hierarchyLevel?: number;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  style?: "classic" | "next-gen";
  issueTypes?: JiraIssueType[];
  components?: { id: string; name: string }[];
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { id: string; name: string };
}

export interface JiraBoard {
  id: number;
  name: string;
  type: "scrum" | "kanban" | "simple";
}

export interface JiraSprint {
  id: number;
  name: string;
  state: "future" | "active" | "closed";
  startDate?: string;
  endDate?: string;
  originBoardId?: number;
}

export interface CreatedIssue {
  id: string;
  key: string;
  self: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
}

const isAdfDoc = (v: unknown): v is AdfDoc =>
  typeof v === "object" && v !== null && (v as AdfDoc).type === "doc" && Array.isArray((v as AdfDoc).content);

/**
 * Cloud: Basic auth with email + API token.
 * Server/DC: a Personal Access Token sent as Bearer (Jira 8.14+), or Basic with
 * username + password on older versions or where the config demands it.
 */
function buildAuthHeader(cfg: Config): string {
  const scheme = cfg.jira.authScheme === "auto" ? (cfg.jira.email ? "basic" : "bearer") : cfg.jira.authScheme;
  return scheme === "bearer" ? `Bearer ${cfg.jira.apiToken}` : basicAuth(cfg.jira.email, cfg.jira.apiToken);
}

/** Projects whose key or name looks close to what was asked for. */
function suggestProjects(
  wanted: string,
  projects: { key: string; name: string }[],
): { key: string; name: string }[] {
  const needle = wanted.toLowerCase();
  if (!needle || needle === "todo") return [];
  return projects
    .filter((p) =>
      p.key.toLowerCase().includes(needle) ||
      needle.includes(p.key.toLowerCase()) ||
      p.name.toLowerCase().includes(needle)
    )
    .slice(0, 5);
}

export type JiraDeployment = "cloud" | "server";

/** Jira Cloud always lives on *.atlassian.net; any other domain is self-hosted. */
function guessDeployment(baseUrl: string): JiraDeployment {
  try {
    return /(^|\.)atlassian\.net$/i.test(new URL(baseUrl).hostname) ? "cloud" : "server";
  } catch {
    return "cloud";
  }
}

export interface JiraServerInfo {
  version?: string;
  deploymentType?: string;
  serverTitle?: string;
}

/**
 * One REST client serving both Jira Cloud and Jira Server / Data Center.
 *
 * The two flavours differ in three core ways:
 *   - API path — `/rest/api/3` (Cloud) vs `/rest/api/2` (Server)
 *   - rich text format — ADF (Cloud) vs wiki markup (Server)
 *   - user identity — `accountId` (Cloud) vs `name` (Server)
 * The Agile API `/rest/agile/1.0` is identical on both.
 */
export class JiraClient {
  private readonly auth: string;
  private deployment: JiraDeployment;
  readonly baseUrl: string;
  readonly projectKey: string;

  constructor(cfg: Config) {
    this.auth = buildAuthHeader(cfg);
    this.baseUrl = cfg.jira.baseUrl;
    this.projectKey = cfg.jira.projectKey;
    this.authScheme = cfg.jira.authScheme === "auto"
      ? (cfg.jira.email ? "basic" : "bearer")
      : cfg.jira.authScheme;
    // Guess from the hostname up front: only *.atlassian.net is Cloud. This
    // matters because a bad token makes /serverInfo return 401 with nothing to
    // refine — guessing Cloud would send every request to a /rest/api/3 that
    // does not exist on a self-hosted instance.
    this.deployment = cfg.jira.deployment === "auto"
      ? guessDeployment(cfg.jira.baseUrl)
      : cfg.jira.deployment;
  }

  /** The auth scheme in use, so error messages name the right thing to fix. */
  private readonly authScheme: "basic" | "bearer";

  get flavor(): JiraDeployment {
    return this.deployment;
  }

  /** Platform API prefix; the Agile API does not use it. */
  private get v(): string {
    return this.deployment === "server" ? "/rest/api/2" : "/rest/api/3";
  }

  /**
   * Ask Jira which flavour it is. `/rest/api/2/serverInfo` exists on both, and
   * its `deploymentType` field distinguishes them precisely.
   */
  async detectDeployment(): Promise<
    { deployment: JiraDeployment; info: JiraServerInfo; confirmed: boolean }
  > {
    const info = await requestJson<JiraServerInfo>(this.api("/rest/api/2/serverInfo"), {
      headers: this.headers(),
      label: "JIRA serverInfo",
      tolerate: [401, 403, 404],
    }).catch(() => ({} as JiraServerInfo));

    const raw = (info?.deploymentType ?? "").toLowerCase();
    // When serverInfo is unreadable (bad token / blocked), keep the hostname
    // guess from the constructor rather than falling back to a default — but
    // report that it is a guess, so callers do not claim the server answered.
    const confirmed = raw === "cloud" || raw === "server";
    if (confirmed) this.deployment = raw as JiraDeployment;
    return { deployment: this.deployment, info: info ?? {}, confirmed };
  }

  /** Force the deployment type, for when the user declares it in .env. */
  setDeployment(deployment: JiraDeployment) {
    this.deployment = deployment;
  }

  /** Rich text: Cloud takes ADF, Server takes a wiki markup string. */
  renderDoc(doc: AdfDoc): AdfDoc | string {
    return this.deployment === "server" ? adfToWiki(doc) : doc;
  }

  /** Convert every ADF value in the payload to wiki when talking to Server. */
  private adaptFields(fields: Record<string, unknown>): Record<string, unknown> {
    if (this.deployment !== "server") return fields;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = isAdfDoc(v) ? adfToWiki(v) : v;
    }
    return out;
  }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: this.auth, Accept: "application/json", ...extra };
  }

  private api(path: string, params: Record<string, string | number | undefined> = {}) {
    const u = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private get<T>(path: string, params?: Record<string, string | number | undefined>) {
    return requestJson<T>(this.api(path, params), { headers: this.headers(), label: `JIRA GET ${path}` });
  }

  private send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
    return requestJson<T>(this.api(path), {
      method,
      headers: this.headers({ "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      label: `JIRA ${method} ${path}`,
    });
  }

  /* ── Metadata ─────────────────────────────────────────────────────────── */

  async myself(): Promise<JiraUser> {
    try {
      return await this.get<JiraUser>(`${this.v}/myself`);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw new Error(
          this.authScheme === "bearer"
            ? `Jira rejected the PAT (HTTP ${err.status}). Check that:\n` +
              `  - the token is still valid and belongs to ${this.baseUrl}\n` +
              `  - JIRA_EMAIL is EMPTY when using a PAT; setting it switches to Basic auth\n` +
              `  - the Jira Server version is 8.14+, the first with Personal Access Tokens`
            : `Jira rejected the login (HTTP ${err.status}). If this is a self-hosted Jira and ` +
              `you are using a Personal Access Token, leave JIRA_EMAIL empty so the token is ` +
              `sent as Bearer.`,
        );
      }
      throw err;
    }
  }

  async getProject(): Promise<JiraProject> {
    try {
      return await this.get<JiraProject>(
        `${this.v}/project/${this.projectKey}`,
        { expand: "issueTypes,description,lead" },
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // A bare "not found" is a dead end, so show what the account can see.
        const visible = await this.listProjects().catch(() => []);
        const near = suggestProjects(this.projectKey, visible);
        throw new Error(
          `Jira project "${this.projectKey}" not found, or the account cannot see it.` +
            (near.length ? `\n  Did you mean: ${near.map((p) => `${p.key} (${p.name})`).join(", ")}` : "") +
            (visible.length
              ? `\n  ${visible.length} project(s) visible to you: ` +
                visible.slice(0, 30).map((p) => p.key).join(", ") +
                (visible.length > 30 ? ", …" : "") +
                `\n  Set JIRA_PROJECT_KEY in .env to one of these, or run \`deno task whoami\` ` +
                `to list them with their names.`
              : `\n  The account cannot see any project at all — check its permissions.`),
        );
      }
      throw err;
    }
  }

  /** Every project the authenticated account can browse. */
  async listProjects(): Promise<{ key: string; name: string }[]> {
    const res = await this.get<{ key: string; name: string }[]>(`${this.v}/project`);
    return (res ?? []).map((p) => ({ key: p.key, name: p.name }));
  }

  async getFields(): Promise<JiraField[]> {
    return await this.get<JiraField[]>(`${this.v}/field`);
  }

  async getComponents(): Promise<{ id: string; name: string }[]> {
    return await this.get<{ id: string; name: string }[]>(
      `${this.v}/project/${this.projectKey}/components`,
    );
  }

  /** Fields that may be set when creating an issue of a given type. */
  async getCreateMetaFields(issueTypeId: string): Promise<Set<string>> {
    if (this.deployment === "server") {
      // Jira 9 / DC 10.x removed the shared createmeta; use the per-issue-type
      // endpoint, falling back to the old one for older Server versions.
      try {
        const res = await this.get<
          { values?: { fieldId: string }[]; fields?: { fieldId: string }[] }
        >(`${this.v}/issue/createmeta/${this.projectKey}/issuetypes/${issueTypeId}`, {
          maxResults: 200,
        });
        return new Set((res.values ?? res.fields ?? []).map((f) => f.fieldId));
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 404) throw err;
      }
      const res = await this.get<
        { projects?: { issuetypes?: { id: string; fields?: Record<string, unknown> }[] }[] }
      >(`${this.v}/issue/createmeta`, {
        projectKeys: this.projectKey,
        issuetypeIds: issueTypeId,
        expand: "projects.issuetypes.fields",
      });
      const type = res.projects?.[0]?.issuetypes?.find((t) => t.id === issueTypeId) ??
        res.projects?.[0]?.issuetypes?.[0];
      return new Set(Object.keys(type?.fields ?? {}));
    }
    const res = await this.get<{ fields?: { fieldId: string }[]; values?: { fieldId: string }[] }>(
      `${this.v}/issue/createmeta/${this.projectKey}/issuetypes/${issueTypeId}`,
      { maxResults: 200 },
    );
    return new Set((res.fields ?? res.values ?? []).map((f) => f.fieldId));
  }

  /**
   * Statuses grouped by issue type. A project can attach a different workflow
   * to each type, so the flat list hides which transitions are actually
   * reachable for a given issue.
   */
  async getStatusesByType(): Promise<{ issueType: string; statuses: string[] }[]> {
    const res = await this.get<{ name: string; statuses: { name: string }[] }[]>(
      `${this.v}/project/${this.projectKey}/statuses`,
    );
    return (res ?? []).map((t) => ({
      issueType: t.name,
      statuses: (t.statuses ?? []).map((s) => s.name),
    }));
  }

  async getStatuses(): Promise<{ name: string; id: string }[]> {
    const res = await this.get<{ statuses: { name: string; id: string }[] }[]>(
      `${this.v}/project/${this.projectKey}/statuses`,
    );
    const seen = new Map<string, { name: string; id: string }>();
    for (const type of res) for (const s of type.statuses ?? []) seen.set(s.id, s);
    return [...seen.values()];
  }

  async getIssueLinkTypes(): Promise<{ id: string; name: string; inward: string; outward: string }[]> {
    const res = await this.get<
      { issueLinkTypes: { id: string; name: string; inward: string; outward: string }[] }
    >(
      `${this.v}/issueLinkType`,
    );
    return res.issueLinkTypes ?? [];
  }

  /* ── Users ────────────────────────────────────────────────────────────── */

  async findUserByEmail(email: string): Promise<JiraUser | null> {
    try {
      // Server takes a `username` parameter, Cloud takes `query`.
      const params = this.deployment === "server"
        ? { username: email, maxResults: 5 }
        : { query: email, maxResults: 5 };
      const res = await this.get<(JiraUser & { name?: string; key?: string })[]>(
        `${this.v}/user/search`,
        params,
      );
      const exact = res.find((u) => u.emailAddress?.toLowerCase() === email.toLowerCase());
      const found = exact ?? res[0];
      if (!found) return null;
      // Server has no accountId; the identity is `name`. Normalise onto accountId
      // so the rest of the pipeline never has to care.
      return { ...found, accountId: found.accountId ?? found.name ?? found.key ?? "" };
    } catch (err) {
      // 403 when the site disables user search or the account lacks Browse users.
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return null;
      throw err;
    }
  }

  /** Cloud sets assignee via `{id}`, Server via `{name}`. */
  assigneeRef(accountId: string): Record<string, string> {
    return this.deployment === "server" ? { name: accountId } : { id: accountId };
  }

  /** Explicit "no assignee" so create does not fall back to the project's default assignee (usually the lead). */
  unassignedRef(): Record<string, null> {
    return this.deployment === "server" ? { name: null } : { id: null };
  }

  /* ── Issues ───────────────────────────────────────────────────────────── */

  async createIssue(fields: Record<string, unknown>): Promise<CreatedIssue> {
    return await this.send<CreatedIssue>("POST", `${this.v}/issue`, { fields: this.adaptFields(fields) });
  }

  async updateIssue(idOrKey: string, fields: Record<string, unknown>): Promise<void> {
    const body = { fields: this.adaptFields(fields) };
    try {
      await this.send<void>("PUT", `${this.v}/issue/${idOrKey}?notifyUsers=false`, body);
    } catch (err) {
      // Suppressing notifications needs (project) admin on Server / DC; if that
      // is the only obstacle, retry with notifications left on rather than fail.
      if (err instanceof HttpError && err.status === 403) {
        await this.send<void>("PUT", `${this.v}/issue/${idOrKey}`, body);
      } else {
        throw err;
      }
    }
  }

  async getIssue(idOrKey: string, fields = "summary,status,issuetype,parent"): Promise<
    { id: string; key: string; fields: Record<string, unknown> } | null
  > {
    try {
      return await this.get(`${this.v}/issue/${idOrKey}`, { fields });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async searchByJql(jql: string, fields = "summary"): Promise<{ id: string; key: string }[]> {
    const out: { id: string; key: string }[] = [];

    if (this.deployment === "server") {
      // Server pages with startAt/total; there is no nextPageToken.
      let startAt = 0;
      while (true) {
        const res = await this.send<{ issues: { id: string; key: string }[]; total: number }>(
          "POST",
          `${this.v}/search`,
          { jql, fields: fields.split(","), maxResults: 100, startAt },
        );
        const batch = res.issues ?? [];
        out.push(...batch);
        startAt += batch.length;
        if (!batch.length || startAt >= (res.total ?? 0)) break;
      }
      return out;
    }

    let nextPageToken: string | undefined;
    do {
      const res = await this.send<{ issues: { id: string; key: string }[]; nextPageToken?: string }>(
        "POST",
        `${this.v}/search/jql`,
        { jql, fields: fields.split(","), maxResults: 100, nextPageToken },
      );
      out.push(...(res.issues ?? []));
      nextPageToken = res.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  async addComment(idOrKey: string, body: AdfDoc): Promise<void> {
    await this.send<void>("POST", `${this.v}/issue/${idOrKey}/comment`, { body: this.renderDoc(body) });
  }

  async getComments(idOrKey: string): Promise<{ id: string; body: unknown }[]> {
    const res = await this.get<{ comments: { id: string; body: unknown }[] }>(
      `${this.v}/issue/${idOrKey}/comment`,
    );
    return res.comments ?? [];
  }

  async updateComment(idOrKey: string, commentId: string, body: AdfDoc): Promise<void> {
    await this.send<void>("PUT", `${this.v}/issue/${idOrKey}/comment/${commentId}`, {
      body: this.renderDoc(body),
    });
  }

  async deleteComment(idOrKey: string, commentId: string): Promise<void> {
    await this.send<void>("DELETE", `${this.v}/issue/${idOrKey}/comment/${commentId}`);
  }

  async createIssueLink(type: string, inwardKey: string, outwardKey: string): Promise<void> {
    await this.send<void>("POST", `${this.v}/issueLink`, {
      type: { name: type },
      inwardIssue: { key: inwardKey },
      outwardIssue: { key: outwardKey },
    });
  }

  async getTransitions(idOrKey: string): Promise<JiraTransition[]> {
    const res = await this.get<{ transitions: JiraTransition[] }>(
      `${this.v}/issue/${idOrKey}/transitions`,
      { expand: "transitions.fields" },
    );
    return res.transitions ?? [];
  }

  async doTransition(idOrKey: string, transitionId: string): Promise<void> {
    await this.send<void>("POST", `${this.v}/issue/${idOrKey}/transitions`, {
      transition: { id: transitionId },
    });
  }

  /**
   * Move an issue to the target status. When one hop is not enough, walk up to
   * `maxHops` intermediate steps (workflows are usually To Do -> In Progress -> Done).
   */
  async transitionTo(idOrKey: string, targetStatus: string, maxHops = 3): Promise<boolean> {
    const target = targetStatus.toLowerCase();
    const visited = new Set<string>();

    // Most created issues already sit at the target status (usually To Do), so
    // check first: it avoids a pointless API call and avoids a false failure when
    // the workflow offers no transition out of the current status.
    const current = await this.getIssue(idOrKey, "status");
    const currentName = (current?.fields.status as { name?: string } | undefined)?.name ?? "";
    if (currentName.toLowerCase() === target) return true;

    for (let hop = 0; hop < maxHops; hop++) {
      const transitions = await this.getTransitions(idOrKey);
      if (!transitions.length) return false;

      const direct = transitions.find((t) => t.to.name.toLowerCase() === target);
      if (direct) {
        await this.doTransition(idOrKey, direct.id);
        return true;
      }
      const next = transitions.find((t) => !visited.has(t.to.id));
      if (!next) return false;
      visited.add(next.to.id);
      await this.doTransition(idOrKey, next.id);
    }
    const final = await this.getIssue(idOrKey, "status");
    const name = (final?.fields.status as { name?: string } | undefined)?.name ?? "";
    return name.toLowerCase() === target;
  }

  async addAttachment(idOrKey: string, fileName: string, data: Uint8Array): Promise<{ id: string }[]> {
    const form = new FormData();
    form.append("file", new Blob([data as unknown as BlobPart]), fileName);
    return await requestJson<{ id: string }[]>(
      this.api(`${this.v}/issue/${idOrKey}/attachments`),
      {
        method: "POST",
        headers: this.headers({ "X-Atlassian-Token": "no-check" }),
        body: form,
        label: `JIRA attach ${fileName}`,
      },
    );
  }

  /* ── Agile ────────────────────────────────────────────────────────────── */

  async getBoards(): Promise<JiraBoard[]> {
    const out: JiraBoard[] = [];
    let startAt = 0;
    while (true) {
      const res = await this.get<{ values: JiraBoard[]; isLast: boolean }>("/rest/agile/1.0/board", {
        projectKeyOrId: this.projectKey,
        startAt,
        maxResults: 50,
      });
      out.push(...(res.values ?? []));
      if (res.isLast || !res.values?.length) break;
      startAt += res.values.length;
    }
    return out;
  }

  async getSprints(boardId: number): Promise<JiraSprint[]> {
    const out: JiraSprint[] = [];
    let startAt = 0;
    while (true) {
      const res = await this.get<{ values: JiraSprint[]; isLast: boolean }>(
        `/rest/agile/1.0/board/${boardId}/sprint`,
        { startAt, maxResults: 50 },
      );
      out.push(...(res.values ?? []));
      if (res.isLast || !res.values?.length) break;
      startAt += res.values.length;
    }
    return out;
  }

  async createSprint(input: {
    name: string;
    originBoardId: number;
    startDate?: string;
    endDate?: string;
    goal?: string;
  }): Promise<JiraSprint> {
    return await this.send<JiraSprint>("POST", "/rest/agile/1.0/sprint", input);
  }

  async updateSprint(sprintId: number, patch: Partial<JiraSprint> & { state?: string }): Promise<void> {
    await this.send<void>("POST", `/rest/agile/1.0/sprint/${sprintId}`, patch);
  }

  /** Add issues to a sprint (at most 50 per request). */
  async moveIssuesToSprint(sprintId: number, issueKeys: string[]): Promise<void> {
    for (const batch of chunk(issueKeys, 50)) {
      await this.send<void>("POST", `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: batch });
    }
  }

  async moveIssuesToBacklog(issueKeys: string[]): Promise<void> {
    for (const batch of chunk(issueKeys, 50)) {
      await this.send<void>("POST", "/rest/agile/1.0/backlog/issue", { issues: batch });
    }
  }

  /** Rank `issueKeys` directly after `afterKey`, preserving array order. */
  async rankAfter(issueKeys: string[], afterKey: string): Promise<void> {
    for (const batch of chunk(issueKeys, 50)) {
      await this.send<void>("PUT", "/rest/agile/1.0/issue/rank", {
        issues: batch,
        rankAfterIssue: afterKey,
      });
      afterKey = batch[batch.length - 1];
    }
  }

  /** Light ping to detect missing Agile permissions early. */
  async probeAgile(): Promise<boolean> {
    try {
      await this.get("/rest/agile/1.0/board", { projectKeyOrId: this.projectKey, maxResults: 1 });
      return true;
    } catch (err) {
      log.debug(`Agile API unavailable: ${(err as Error).message}`);
      return false;
    }
  }

  async downloadUrl(url: string): Promise<Uint8Array> {
    const res = await request(url, { headers: this.headers() });
    return new Uint8Array(await res.arrayBuffer());
  }
}
