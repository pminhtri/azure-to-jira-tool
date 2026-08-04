# Azure DevOps → Jira migration

A TypeScript tool, run with Deno, that migrates an entire Azure DevOps project
into Jira: work items, hierarchy, links, comments, history, attachments,
sprints, backlog order, tags and estimates. Works against both **Jira Cloud**
and **Jira Server / Data Center**.

The architecture is **two separate phases**:

```
Azure DevOps ──[export]──┐
   (REST API)            ├──▶ .data/ (JSON + files) ──[import]──▶ Jira
CSV export file ─[csv]───┘                                │
                                                     .state/ (checkpoint)
```

The load phase only reads from the source. The import phase only reads from disk
and writes to Jira. That means you can re-run the import as many times as you
like without touching ADO again, and every failure can be debugged against
static data.

## Choosing a source: REST API or CSV?

Both write the same `.data/` layout, so everything downstream is identical. They
differ in what the source itself can carry:

| | `deno task export` (REST API) | `deno task csv` |
| --- | --- | --- |
| Needs a PAT | yes | no |
| Work items + fields | complete | complete, limited to the columns present |
| Parent-child | yes | only with a `Parent` or `Title 1/2/3` column |
| Links (Relates, Blocks…) | yes | **no** |
| Comments | the full discussion | only the last change note in `History` |
| Revision history | yes | **no** |
| Attachments | downloaded | **no** (a CSV only has the file count) |
| Sprint dates | yes | **no** — declare them in `sprintDates` |

**Use the REST API if you can get a PAT.** CSV makes sense when you cannot, or
for a quick mapping rehearsal before the real run.

### Getting the most out of a CSV export

Boards → Queries → create a query → **Column Options**, and add at least:
`ID`, `Work Item Type`, `Title`, `State`, `Assigned To`, `Area Path`,
`Iteration Path`, `Description`, `Tags`, `Created Date`, `Created By`,
**`Parent`** ← important, plus `Story Points` / `Backlog Priority` if you use
them. Then Export to CSV.

Without the `Parent` column, Epics / Features / Tasks arrive in Jira as flat
issues — the `csv` command says so explicitly and explains the fix.

### Exporting via an existing ADO query

If a query on the web already scopes exactly what you want to migrate, run it
directly instead of scanning the whole project:

```bash
deno task queries                     # list saved queries with their GUIDs
deno task export --query=<guid>
deno task export --query="Shared Queries/Context Engine/Backlog"
```

> A query URL containing `?tempQueryId=...` is a **temporary query**. It lives
> only in your browser session and cannot be called through the API. Click
> **Save query** first; the URL then becomes `_queries/query/<guid>`.

Prefer a **tree** query ("Tree of work items"): it returns parent-child
relations directly, and the tool uses them to fill in `System.Parent` wherever
that field is empty.

### Merging several CSV files

One ADO query usually covers only part of the backlog. Pass several files to
merge them by ID; later files win when IDs collide:

```bash
deno task csv sprint-1.csv sprint-2.csv backlog.csv
```

The command prints how many new work items each file contributed and warns about
any file that contributed nothing (i.e. a subset of an earlier one). Attachments
are counted per work item, so repeats across files are never double counted.

## Testing the connection

Before anything else:

```bash
deno task whoami
```

It needs only `JIRA_BASE_URL` and `JIRA_API_TOKEN` — no project key — and prints
the URL, the auth scheme it chose, the Jira edition and who you authenticated
as. It also warns when an email is set against a self-hosted Jira, which
silently switches a PAT to Basic auth and gets it rejected.

### "returned an HTML login page instead of JSON"

An API path answering with HTML means a corporate SSO / VPN gateway (F5 BIG-IP
APM, Okta, Azure App Proxy…) intercepted the call, so the credentials never
reached Jira at all. The token is not the problem — the network path is.
Connect to the company VPN, or run the migration from a machine inside that
network.

### "invalid peer certificate: UnknownIssuer"

Deno ships its own CA store and ignores the OS one, so an internal corporate CA
(common for an on-prem Jira Server / Data Center) is not trusted by default.
Either use the operating system store or point Deno at an exported CA bundle by
adding one of these to your `.env`:

```bash
DENO_TLS_CA_STORE=system
# or
DENO_CERT=/path/to/ca.pem
```

## Requirements

- [Deno](https://deno.com) 2.x (tested on 2.9.4)
- **Azure DevOps PAT** with read access to `Work Items` and `Project and Team`
- **Jira credentials** for an account with `Administer Projects` on the target
  project — needed to create sprints and transition issues
- The target Jira project **must already exist**, and must be Jira Software if
  you want sprints

### Jira Cloud vs Jira Server / Data Center

The tool detects which one it is talking to (via `/rest/api/2/serverInfo`, with
the hostname as a fallback) and adapts automatically:

| | Cloud | Server / Data Center |
| --- | --- | --- |
| API path | `/rest/api/3` | `/rest/api/2` |
| Rich text | ADF (JSON) | wiki markup |
| Auth | email + API token (Basic) | Personal Access Token (Bearer) |
| Assignee | `accountId` | `username` |
| Link to an Epic | the `parent` field | the **Epic Link** custom field |

For a self-hosted Jira with a PAT, leave `JIRA_EMAIL` **empty** — the tool then
sends the token as `Bearer`. Setting an email switches it to Basic auth, which a
PAT will not satisfy. `JIRA_DEPLOYMENT` and `JIRA_AUTH` can force either choice.

> On Server / Data Center the `parent` field only works for sub-tasks. Set
> `fields.epicLink` in the config, or every Epic relation degrades to a
> "Relates" link.

### Which boards can hold sprints?

The Jira UI calls them all "Agile board", but the API distinguishes three types
and only two of them have sprints:

| API `type` | What it is | Sprints? |
| --- | --- | --- |
| `scrum` | A Scrum board on a company-managed project | yes |
| `simple` | A team-managed (next-gen) board | yes, once Project settings → Features → **Sprints** is on |
| `kanban` | A Kanban board | **no** |

Run `deno task fields` to see which one your project has. If no board can hold
sprints, set `options.includeSprints = false` to skip that part rather than
having it warn on every run.

## Quick start

```bash
cp .env.example .env      # then fill in the credentials
deno task whoami          # verify the connection before anything else
deno task export          # download all of ADO into .data/
deno task fields          # inspect Jira issue types / statuses / custom fields
# → update migration.config.json to match
deno task plan            # preview the mapping and spot gaps
deno task import --limit=20 --dry-run
deno task import --limit=20    # try 20 issues, then check them by hand in Jira
deno task import               # run the whole thing
deno task verify               # reconcile ADO against Jira
```

## Commands

| Command | What it does | Writes to Jira? |
| --- | --- | --- |
| `deno task queries` | List saved ADO queries with their GUIDs and type (flat/tree) | no |
| `deno task export` | Download work items, comments, history, attachments, iterations, teams | no |
| `deno task csv <a.csv> [b.csv …]` | Load an ADO CSV export into the same `.data/` layout | no |
| `deno task whoami` | Test the Jira URL, credentials and auth scheme only | no |
| `deno task fields` | Print Jira issue types / statuses / link types / boards / custom fields | no |
| `deno task plan` | Analyse `.data/`, print the intended mapping, flag undeclared types/states | no |
| `deno task import` | Push data into Jira, phase by phase | **yes** |
| `deno task verify` | Reconcile counts and statuses between the two systems | no |

### Options

```
--dry-run              Print what would happen; make no write calls
--phase=<a,b,...>      Run only the named phases
--only=<id,id,...>     Process only these ADO work item ids
--limit=<n>            Cap the number of work items
--no-resume            (export) re-download work items already on disk
--date-order=<v>       (csv) month-first | day-first, inferred by default
--query=<id|path>      (export) run a saved ADO query instead of scanning the project
--config=<path>        Path to an alternative config file
--reset-state          Delete the state file before running
--verbose, -v          Verbose logging
```

## Import phases

They run in order, and each one resumes independently. The ordering is
deliberate: issues are created in their default status and transitioned last, so
workflow validators cannot block creation.

| # | Phase | What it does |
| --- | --- | --- |
| 1 | `preflight` | Check credentials, issue types, statuses, custom fields, board. Fail fast on a bad mapping |
| 2 | `users` | Map ADO users onto Jira accounts by email |
| 3 | `sprints` | Create sprints from the iterations work items actually use |
| 4 | `issues` | Create issues, parents before children |
| 5 | `hierarchy` | Set `parent` / Epic Link; relations that cannot nest degrade to a link |
| 6 | `links` | Create issue links (Relates, Blocks, Duplicate…) |
| 7 | `attachments` | Upload files, re-render descriptions containing inline images |
| 8 | `comments` | Write comments plus one comment summarising the whole history |
| 9 | `sprint-assign` | Add issues to sprints and close sprints that already ended |
| 10 | `rank` | Order the backlog by the ADO `StackRank` |
| 11 | `transitions` | Move issues to their target status |

Re-run a single phase:

```bash
deno task import --phase=comments
deno task import --phase=attachments,transitions
```

## Mapping configuration

All mapping lives in `migration.config.json`. Run `deno task fields` to get the
real names and IDs, then fill them in.

### Issue types and statuses

```json
{
  "issueType": { "User Story": "Story", "Bug": "Bug", "_default": "Task" },
  "status":    { "Active": "In Progress", "Closed": "Done", "_default": "To Do" }
}
```

`_default` covers anything not declared. `deno task plan` lists every type and
state currently falling back to it.

### Custom fields

```json
"fields": {
  "storyPoints": "customfield_10016",
  "epicLink":    "customfield_10014",
  "adoId":       "customfield_10099",
  "adoUrl":      null
}
```

Leave a field `null` if the project does not have it — the tool skips it instead
of failing. `adoId` / `adoUrl` are well worth configuring: they keep a link back
to ADO and make issues findable by JQL afterwards. On Server / Data Center,
`epicLink` is what makes Epic relations real instead of flat links.

### Users

```json
"users": {
  "autoLookup": true,
  "map": { "an@contoso.com": "5b10a2844c20165700ede21g" }
}
```

With `autoLookup: true` the tool resolves Jira accounts by email. Anyone it
cannot resolve is listed at the end of the `users` phase so you can map them by
hand (by accountId, username, or email). Issues for unmapped users are left
unassigned.

### Limiting the scope

```json
"options": {
  "wiqlFilter": "AND [System.AreaPath] UNDER 'Contoso\\\\Team A'",
  "includeRemovedWorkItems": false
}
```

## Idempotent and resumable

`.state/<PROJECT_KEY>.state.json` records the ADO work item id → Jira issue key
mapping, plus a per-issue flag for every step that completed. Interrupt a run
(Ctrl-C, network drop, rate limit) and re-running `deno task import` picks up
exactly where it stopped, **creating no duplicates** — issues, links, comments,
attachments or sprints.

This is covered by a test: the last step of the integration test runs the import
a second time and asserts that nothing new is created.

> `--reset-state` only deletes the state file; it does **not** delete issues
> already created in Jira. After a reset, re-running will create duplicates. Use
> it only once the target project has been cleared.

## Error handling

- **Rate limits / 5xx**: retried with exponential backoff and jitter, honouring
  Jira's `Retry-After` header.
- **A field the screen rejects**: if Jira returns 400 naming a field, that field
  is dropped and the request retried — one misconfigured screen cannot break the
  whole migration.
- **Invalid hierarchy**: ADO has four tiers (Epic > Feature > PBI > Task) while
  standard Jira Software has three (Epic > Story/Task/Bug > Sub-task), so some
  relations cannot nest. The tool compares the project's real `hierarchyLevel`
  values first, never sends a doomed request, then tries Epic Link and finally
  degrades to a `Relates` link. The relation stays visible on the issue; only
  the tree shape is lost. `deno task plan` reports the numbers up front.
- **A status more than one hop away**: the tool walks up to three intermediate
  transitions (To Do → In Progress → Done).
- Every non-fatal failure is recorded in the state file with its phase and
  reference, and summarised by phase at the end of the run.

## Content conversion

Jira Cloud uses ADF (Atlassian Document Format); Server / Data Center uses wiki
markup. ADO descriptions arrive in two formats of their own — the rich-text
editor produces HTML, the newer editor produces Markdown — so
`src/jira/markdown.ts` counts block-level signals for both and picks the right
converter per field. Getting that wrong flattens a long Markdown ticket
(headings, checklists, tables) into a wall of plain text.

Markdown → ADF supports headings, nested lists, **task lists** (`- [ ]` becomes
a real Jira checkbox), tables, code fences, blockquotes, links, autolinks, and
CommonMark backslash escapes so Windows paths survive intact.

HTML → ADF (`src/jira/adf.ts`) supports headings, paragraphs, nested lists,
tables, code blocks with language detection, blockquotes, rules,
bold/italic/underline/strike/code/sub/sup, links and images. ADO `@mention`
markup becomes plain text, `javascript:` and malformed hrefs lose their link
mark, and content past Jira's length limit is truncated with a warning panel.

For Server / Data Center, `src/jira/wiki.ts` renders that ADF down to wiki
markup, so all the parsing logic and its tests are shared between both flavours.

The overriding rule is to **never emit invalid ADF** — Jira rejects an entire
issue over a single bad node.

## What the Jira API cannot do

These are Jira limitations, not gaps in the tool:

| ADO data | How it is handled |
| --- | --- |
| Created date / Created by | Cannot be set through the REST API. Recorded in the panel at the top of the description and in the "Azure DevOps fields" table |
| Revision history | Jira does not allow writing changelog entries. Collapsed into a single table comment, keeping the 200 most recent changes |
| Original comment author | Comments are authored by the migrating account; the original author and timestamp appear on the comment's first line |
| Area Path | → a label (prefixed `area-`) and/or a component |
| Remaining/Completed Work | → the description table, unless mapped to a custom field |

If preserving created dates and original reporters is essential, use the Jira
External System Import (the CSV importer, which self-hosted Jira ships with) —
but that route is not resumable and is harder to correct piecemeal.

## Source layout

```
src/
  main.ts              CLI
  config.ts            Reads .env + migration.config.json, validates
  commands.ts          queries / fields / plan / verify
  log.ts               Logger and progress bar
  ado/
    client.ts          Azure DevOps REST client (WIQL, batch, comments, attachments)
    export.ts          Export orchestration and the .data/ layout
    csv.ts             Reads ADO CSV exports into the same .data/ layout
    iterations.ts      Flattens the iteration tree, normalises paths
    types.ts
  jira/
    client.ts          Jira REST client (platform v2/v3 + agile v1.0)
    adf.ts             HTML → ADF
    markdown.ts        Markdown → ADF plus format detection
    wiki.ts            ADF → wiki markup for Server / Data Center
    transform.ts       ADO work item → Jira issue fields
    import.ts          Orchestrates the 11 phases
  util/
    http.ts            fetch with retry/backoff/Retry-After
    state.ts           Durable checkpointing
    pool.ts            Concurrency limiter
    args.ts dotenv.ts fsx.ts colors.ts
```

The only external dependency is `npm:node-html-parser`, used by the HTML → ADF
step. Everything else uses Deno built-ins and `node:path` — JSR is avoided on
purpose, because that registry is blocked on some corporate networks.

## Tests

```bash
deno task test    # 131 tests
deno task check   # type-check
deno lint src/
```

`src/integration_test.ts` stands up mock HTTP servers for **both** Azure DevOps
and Jira Cloud and runs export → import → import-again, asserting every phase:
field mapping, hierarchy fallback, bidirectional link deduplication, attachment
upload and inline-image re-rendering, sprint creation and closing, rank order,
multi-hop transitions, and idempotency. `src/jira/server_test.ts` does the
equivalent against a Jira Server mock, checking that no v3 endpoint is called,
that auth is Bearer, that descriptions are wiki markup and that Epics are linked
via Epic Link. Nothing touches a real system.

## Azure DevOps Server (on-prem)

Point `ADO_BASE_URL` at the collection:

```
ADO_BASE_URL=https://tfs.company.local/tfs/DefaultCollection
ADO_API_VERSION=6.0
```
