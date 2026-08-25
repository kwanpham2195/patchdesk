# Scope the Pull requests screen to one repository and filter with GitHub's vocabulary

> **Status: Accepted. Not yet implemented.** Companion to ADR 0032, which
> removes this screen's polling and makes refresh explicit. Terms in bold
> are defined in `CONTEXT.md`. Current shape recorded in
> `.agents/research/2026-08-25-maintainer-inbox.md`; GitHub's capabilities
> in `.agents/research/2026-08-25-github-pr-search-capabilities.md` — both
> are local working notes under a gitignored path, not in the repository.

The Pull requests screen scans every watched repository of a workspace
profile at once. `MaintainerInboxService.list` reads one GraphQL page
from each repo concurrently, merges the results, sorts them into one
canonical order, and slices that to a page size. Because a single
global page consumes an uneven amount of each repository's own page,
the next-page token has to carry a separate cursor per repository
(`inboxPageTokenSchema`, `src/services/maintainer-inbox-service.ts`).

Each pull request is then projected into a row carrying up to nine
overlapping categories and one recommended action
(`projectMaintainerInboxRow`, `src/domain/maintainer-inbox.ts`). The
renderer filters, sorts, groups, and counts over that flat list.

Pagination broke that arrangement. `filterRows` in
`src/renderer/src/hooks/use-inbox-view.ts` runs over the `rows` prop,
which holds one page. Every queue, search, label filter, and sort
therefore applies to the rows currently loaded rather than to the
repository. "Checks failing" shows the failing pull requests on this
page. The rail counts are page counts. Sorting by change size sorts a
page. The fan-out design needs the whole set in memory to be correct,
and pagination took that away.

## The decision

A maintainer selects one repository, and everything else follows from
that choice. The cross-repository view is removed rather than retained
as a mode.

Within the Selected repository the screen has two sources, and each
owns its whole set.

The **Repository listing** is GitHub's own search, server-side. One
`search(type: ISSUE)` query scoped with `repo:OWNER/NAME is:pr`, with
the **Pull request filter** mirroring GitHub's vocabulary: author, label,
assignee, milestone, project, review state, check status, branch, and
date. Filters, counts, and ordering are GitHub's answers, not a
client-side pass over a page. "Awaiting review from you" becomes a
filter preset (`user-review-requested:@me`), not a distinct queue.

The **Local review listing** is the maintainer's Review sessions for
that repository. It is bounded by how many reviews the maintainer
actually has open here, so it is fetched whole, never paginated, and
always exactly counted.

Nine categories collapse to two **Review indicators**, and both live on
the local side: **Updated since review** and **Ready to merge**.
Neither is a queue. Both sit on the row, alongside CI state, draft, and
merged.

Merged pull requests are a filter value, not a mode. `is:merged` is one
more qualifier in the Pull request filter, so the Open/Merged scope
toggle, the separate merged code path, and the rule that hides the
queue rail in merged scope all go. Merged results are deliberately not
cached: merged history is low value offline, and caching it would
double the cache surface for no gain. The empty state says so rather
than implying a fault.

Three capabilities are cut with this decision.

**Direct entry** is removed, not built. `POST /v1/direct-entry/preview`,
`pull-request-input-service.ts`, and the hardcoded `directEntryAvailable`
field are unreachable from the renderer today, and this decision does
not give them a front door. A maintainer reaches a pull request by
selecting its repository first, with no exception.

**Saved views** are removed. They store six client-side fields, carry no
scope, and already vanish without warning when a stored queue id stops
parsing. The concepts they save — a queue id and a local substring
search — are both deleted by this decision, so there is nothing
coherent to migrate them to.

**Sorting by change size** is removed. The priority sort dies with the
categories it ranks, and the repository sort with the fan-out; change
size is the only remaining sort with no server-side equivalent, and
keeping one client-side sort that silently
orders a single page would reintroduce the exact defect this decision
exists to remove. The header disclosure that admits the defect —
"GitHub updates order this page. Local sorting applies only here." —
is deleted with it.

One constraint carries over from ADR 0023 and must not be lost.
`rateLimit { remaining resetAt }` rides on the listing query the
screen already runs on every refresh, and it is the only place in the
codebase that populates the per-host rate-limit cache. Every other GitHub read and write reads that
cache through `commandFailure` to learn when a limit lifts. Whatever
query replaces `maintainerInboxQuery` must carry that field, and a test
must assert it does — this is a piggyback that already breaks silently
when the query changes, and it would regress the whole app to a blind
sixty-minute wait rather than fail loudly.

`checks_pending`, `authored`, and `draft` are deleted outright — they
are declared and pushed but nothing reads them today. `waiting_for_author`
and `checks_failing` are deleted as categories, and with them the
`open_discussion` recommended action, whose only trigger was
`waiting_for_author`. `saved_review` stops being a filter dimension and
becomes part of the row indicator.

## Why

The split between the two sources is not a matter of taste. It is
forced by what GitHub can express.

GitHub cannot filter on merge conflict state: there is no `mergeable:`
or equivalent qualifier, and `status:` covers CI only. GitHub also
cannot express review staleness — `reviewed-by:` matches anyone who has
submitted a review at some point, and no qualifier compares that review
against the current head. Those two absences are exactly the two signals
Patchdesk keeps locally. There is no arrangement in which they move
server-side.

Everything else the screen invented, GitHub already had. Every discovery
category being deleted is a qualifier GitHub supports directly —
`status:failure`, `status:pending`, `draft:true`, `author:@me`,
`review:changes_requested`. Removing them costs no capability. It trades
a hand-built taxonomy of nine for GitHub's vocabulary, which also brings
assignee, milestone, project, branch, date range, comment count, and
linked-issue filters the screen does not have today.

Fixing the repository first is what makes server-side filtering
possible at all. A single `repo:` qualifier fits comfortably inside
GitHub's documented 256-character query limit; composing one query
across every watched repository does not, and would still return a
merged result the client has to re-sort and re-slice — the same problem
in a new place.

Most of the complexity in the current design exists only to serve the
fan-out. With one repository the page token carries one cursor instead
of a bundle, so the repository-set match check, the 16 KiB bound, and
the empty-non-final-page fix stop being needed. Data freshness stops
being a collapse of many outcomes into one flag, so a single
rate-limited repository no longer strips `ready_to_merge` from rows
that came back live. The cache stops being restricted to page one of
open scope. One GraphQL call replaces a bounded fan-out. The
de-duplication question, the host and owner sort tiebreakers, the
repository multi-select, the repository column, and the repository sort
option all become dead.

## Rejected alternatives

**Keep an "All repositories" choice beside the picker.** This preserves
cross-repository triage, which is the one thing the fan-out buys. It was
rejected because keeping it keeps everything: the per-repository cursor
bundle, the collapsed freshness flag, the merge-and-slice step, and a
second code path that cannot use server-side filtering. The complexity
does not scale down with usage.

**Fetch the whole repository and keep filtering on the client.** This
restores correct filters and counts with the least new code, since the
existing projection and filter functions would work unchanged against a
complete set. Rejected because it caps the repository size the screen can
serve, and because it declines capability GitHub gives away — assignee,
milestone, project, and date filters would each need building by hand.

**Keep the nine categories and filter server-side underneath them.**
Rejected because four of the nine cannot be expressed as qualifiers, so
the taxonomy would have to be satisfied from two sources per queue and
merged — reintroducing at the category level the merge this decision
removes at the repository level.

## Consequences

- Cross-repository triage is gone, and there is no direct-entry escape
  hatch either. A maintainer watching several repositories answers
  "what needs me anywhere" by selecting each in turn, or on GitHub.
  The watchlist becomes a repository picker.
- Filters and counts become correct. This is a behaviour fix, not only
  a simplification: today they silently describe one page.
- The `open_discussion` action disappears with `waiting_for_author`.
  Reaching an author's response needs another route into the workbench.
- The renderer contract accepts a `running` category the domain can
  never emit. It should go with this change.
- GraphQL `search` cursor stability under a changing result set is
  undocumented. ADR 0032 removes the poll, so drift is no longer probed
  once a minute — but paging forward and back across a manual refresh
  is still exposed to it, so it must be tested rather than assumed.
- Search caps at 1,000 results and gives no documented signal for a
  truncated or timed-out query, unlike REST's `incomplete_results`.
  A repository past that ceiling cannot be paged to the end.
- `dashboard-service.ts` holds a second, independent multi-repository
  scan behind `dashboardForActiveProfile`. It is already unreachable —
  `GET /v1/dashboard` is a deleted route with a 404 regression test — so
  removing the fan-out does not disturb it. Its live half,
  `discoverWorkspaceRepos`, is a local git-origin scan and stays.
- The watchlist setup flow makes no GitHub call and does not depend on
  the scan.
- The command palette jumps to queues through `window` custom events
  (`patchdesk:inbox-view`, `patchdesk:inbox-action`) rather than props.
  Deleting queue ids breaks it at runtime with nothing to catch it. The
  palette and the filter bar must read one shared list of presets.
- The label filter builds its options from the labels found on loaded
  rows, so it can only offer labels already on screen. Server-side
  label filtering needs the repository's own label set;
  `listRepositoryLabels` already exists and serves the workbench rail.
- A repository with no matching pull requests is currently
  indistinguishable from a filter that excludes everything — both show
  "No open pull requests match this view." With one repository the
  empty state is the whole screen, so being caught up and matching
  nothing have to read differently.
- Merged results have no cached view, by decision. With GitHub
  unreachable the merged filter shows nothing.
