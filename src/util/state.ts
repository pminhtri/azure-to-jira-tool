import { dirname, join } from "node:path";
import { ensureDir } from "./fsx.ts";

export interface IssueRecord {
  key: string;
  id: string;
  issueType: string;
  /** Whether parent / epic link has been set. */
  parentDone?: boolean;
  linksDone?: boolean;
  attachmentsDone?: boolean;
  commentsDone?: boolean;
  historyDone?: boolean;
  transitionDone?: boolean;
  sprintDone?: boolean;
}

export interface MigrationState {
  version: 1;
  startedAt: string;
  updatedAt: string;
  jiraProjectKey: string;
  /** ADO work item id -> the issue created in Jira. */
  issues: Record<string, IssueRecord>;
  /** ADO iteration path -> Jira sprint id. */
  sprints: Record<string, number>;
  /** Board used to create sprints. */
  boardId: number | null;
  /** ADO user uniqueName -> Jira accountId ("" means not found). */
  users: Record<string, string>;
  /** ADO attachment GUID -> the attachment uploaded to Jira. */
  attachments: Record<string, { id: string; issueKey: string; fileName: string }>;
  /** Phases that completed in full. */
  phasesDone: string[];
  /** Failures recorded for later review; they never halt the run. */
  failures: { phase: string; ref: string; message: string; at: string }[];
  /** Last rank applied, so the rank phase can resume. */
  rankCursor: number;
}

/**
 * Durable migration state — lets a run stop midway and resume without creating
 * duplicate issues. Writes are debounced to avoid excessive I/O.
 */
export class Store {
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private constructor(readonly path: string, readonly data: MigrationState) {}

  static async open(stateDir: string, projectKey: string): Promise<Store> {
    const path = join(stateDir, `${projectKey}.state.json`);
    await ensureDir(dirname(path));
    let data: MigrationState;
    try {
      data = JSON.parse(await Deno.readTextFile(path)) as MigrationState;
      if (data.jiraProjectKey !== projectKey) {
        throw new Error(
          `State file ${path} belongs to project ${data.jiraProjectKey}, not ${projectKey}.`,
        );
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        if (err instanceof Error && err.message.includes("belongs to project")) throw err;
      }
      data = {
        version: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        jiraProjectKey: projectKey,
        issues: {},
        sprints: {},
        boardId: null,
        users: {},
        attachments: {},
        phasesDone: [],
        failures: [],
        rankCursor: 0,
      };
    }
    // Older state files may be missing keys added in later versions.
    data.attachments ??= {};
    data.sprints ??= {};
    data.users ??= {};
    data.boardId ??= null;
    return new Store(path, data);
  }

  issue(adoId: number | string): IssueRecord | undefined {
    return this.data.issues[String(adoId)];
  }

  setIssue(adoId: number | string, rec: IssueRecord) {
    this.data.issues[String(adoId)] = rec;
    this.touch();
  }

  patchIssue(adoId: number | string, patch: Partial<IssueRecord>) {
    const cur = this.data.issues[String(adoId)];
    if (!cur) return;
    Object.assign(cur, patch);
    this.touch();
  }

  fail(phase: string, ref: string, message: string) {
    this.data.failures.push({ phase, ref, message: message.slice(0, 600), at: new Date().toISOString() });
    this.touch();
  }

  markPhase(phase: string) {
    if (!this.data.phasesDone.includes(phase)) this.data.phasesDone.push(phase);
    this.touch();
  }

  isPhaseDone(phase: string) {
    return this.data.phasesDone.includes(phase);
  }

  touch() {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 1000);
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.data.updatedAt = new Date().toISOString();
    const tmp = `${this.path}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(this.data, null, 2));
    await Deno.rename(tmp, this.path);
  }

  async close() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = true;
    await this.flush();
  }
}
