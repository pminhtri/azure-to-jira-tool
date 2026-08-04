import type { Config, MappingConfig } from "../config.ts";

/** A complete config for tests, independent of environment variables. */
export function makeConfig(overrides: {
  mapping?: Partial<MappingConfig>;
  dataDir?: string;
  stateDir?: string;
} = {}): Config {
  return {
    ado: {
      org: "contoso",
      project: "Contoso",
      pat: "x",
      apiVersion: "7.1",
      baseUrl: "https://dev.azure.com/contoso",
    },
    jira: {
      baseUrl: "https://x.atlassian.net",
      email: "a@b.c",
      apiToken: "t",
      projectKey: "WEB",
      boardName: null,
      deployment: "auto",
      authScheme: "auto",
    },
    concurrency: 4,
    maxAttachmentBytes: 10 * 1024 * 1024,
    dataDir: overrides.dataDir ?? ".data",
    stateDir: overrides.stateDir ?? ".state",
    mapping: {
      options: {
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
      },
      issueType: { "User Story": "Story", Feature: "Epic", Epic: "Epic", Bug: "Bug", _default: "Task" },
      status: { Active: "In Progress", Closed: "Done", Done: "Done", _default: "To Do" },
      priority: { "1": "Highest", "2": "High", _default: "Medium" },
      linkType: {},
      fields: {
        storyPoints: "customfield_10016",
        sprint: null,
        epicLink: null,
        epicName: null,
        adoId: "customfield_10099",
        adoUrl: null,
        originalEstimate: null,
        startDate: null,
      },
      labels: {
        fromTags: true,
        fromAreaPath: true,
        fromWorkItemType: false,
        areaPathPrefix: "area-",
        workItemTypePrefix: "ado-",
        extra: ["migrated-from-ado"],
      },
      components: { fromAreaPath: false, map: {} },
      users: { autoLookup: true, fallbackToUnassigned: true, map: {} },
      sprintDates: {},
      ...overrides.mapping,
    },
  };
}
