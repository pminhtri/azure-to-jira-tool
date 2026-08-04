export interface AdoIdentity {
  displayName?: string;
  uniqueName?: string;
  id?: string;
  imageUrl?: string;
}

export interface AdoRelation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown> & { name?: string; comment?: string; resourceSize?: number };
}

export interface AdoWorkItemFields {
  "System.Id"?: number;
  "System.WorkItemType"?: string;
  "System.Title"?: string;
  "System.State"?: string;
  "System.Reason"?: string;
  "System.AssignedTo"?: AdoIdentity;
  "System.CreatedBy"?: AdoIdentity;
  "System.CreatedDate"?: string;
  "System.ChangedBy"?: AdoIdentity;
  "System.ChangedDate"?: string;
  "System.AreaPath"?: string;
  "System.IterationPath"?: string;
  "System.Tags"?: string;
  "System.Description"?: string;
  "System.Parent"?: number;
  "Microsoft.VSTS.Common.Priority"?: number;
  "Microsoft.VSTS.Common.Severity"?: string;
  "Microsoft.VSTS.Common.StackRank"?: number;
  "Microsoft.VSTS.Common.BacklogPriority"?: number;
  "Microsoft.VSTS.Common.AcceptanceCriteria"?: string;
  "Microsoft.VSTS.Common.ClosedDate"?: string;
  "Microsoft.VSTS.Common.ResolvedDate"?: string;
  "Microsoft.VSTS.Scheduling.StoryPoints"?: number;
  "Microsoft.VSTS.Scheduling.Effort"?: number;
  "Microsoft.VSTS.Scheduling.OriginalEstimate"?: number;
  "Microsoft.VSTS.Scheduling.RemainingWork"?: number;
  "Microsoft.VSTS.Scheduling.CompletedWork"?: number;
  "Microsoft.VSTS.Scheduling.StartDate"?: string;
  "Microsoft.VSTS.Scheduling.TargetDate"?: string;
  "Microsoft.VSTS.Scheduling.DueDate"?: string;
  "Microsoft.VSTS.TCM.ReproSteps"?: string;
  "Microsoft.VSTS.TCM.SystemInfo"?: string;
  [key: string]: unknown;
}

export interface AdoWorkItem {
  id: number;
  rev: number;
  url: string;
  fields: AdoWorkItemFields;
  relations?: AdoRelation[];
  _links?: { html?: { href: string } };
}

export interface AdoComment {
  id: number;
  workItemId: number;
  version: number;
  text: string;
  createdBy?: AdoIdentity;
  createdDate?: string;
  modifiedDate?: string;
}

export interface AdoUpdate {
  id: number;
  rev: number;
  revisedBy?: AdoIdentity;
  revisedDate?: string;
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
  relations?: {
    added?: AdoRelation[];
    removed?: AdoRelation[];
  };
}

export interface AdoClassificationNode {
  id: number;
  identifier: string;
  name: string;
  structureType: "area" | "iteration";
  hasChildren: boolean;
  path: string;
  attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
  children?: AdoClassificationNode[];
}

export interface AdoTeam {
  id: string;
  name: string;
  description?: string;
}

export interface AdoTeamIteration {
  id: string;
  name: string;
  path: string;
  attributes?: { startDate?: string; finishDate?: string; timeFrame?: "past" | "current" | "future" };
}

/** A flattened iteration, ready to be mapped onto a Jira sprint. */
export interface FlatIteration {
  path: string;
  name: string;
  startDate: string | null;
  finishDate: string | null;
  /** Derived from the dates: future | current | past. */
  timeFrame: "future" | "current" | "past";
  depth: number;
  isLeaf: boolean;
}

export interface AttachmentManifestEntry {
  workItemId: number;
  /** GUID taken from the ADO attachment URL. */
  guid: string;
  fileName: string;
  /** Path relative to DATA_DIR. */
  file: string;
  size: number;
  comment?: string;
  /** True for images embedded in a description/comment rather than standalone attachments. */
  inline: boolean;
  skipped?: string;
}

/** The complete exported payload for a single work item. */
export interface ExportedWorkItem {
  workItem: AdoWorkItem;
  comments: AdoComment[];
  updates: AdoUpdate[];
  attachments: AttachmentManifestEntry[];
}

export interface ExportManifest {
  exportedAt: string;
  org: string;
  project: string;
  projectId: string;
  workItemCount: number;
  workItemIds: number[];
  typeCounts: Record<string, number>;
  stateCounts: Record<string, number>;
  iterationCount: number;
  attachmentCount: number;
  commentCount: number;
}
