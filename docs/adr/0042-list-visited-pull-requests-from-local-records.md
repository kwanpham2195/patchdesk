# List visited pull requests from local Review records

> **Status: Accepted. Implemented in PR #137 on
> `feat/119-visited-pull-requests`** — the column, `GET /v1/sidebar/reviews`,
> the `title` and `lastOpenedAt` fields on the Review record, and the retention
> change that sweeps a record with its session. Issue #119. Companion to ADR
> 0031, which turned the watchlist into a repository picker, and ADR 0032,
> which removed this app's last refresh timer.

Patchdesk has one route back to a pull request the maintainer already opened:
find it again in the Pull requests table. Under ADR 0031 that table is GitHub's
own search over one selected repository, so a pull request read yesterday is
reachable only while it still matches the current filter and page, and resuming
it costs the same GitHub call as finding it did.

Everything needed to list it is already on disk. A durable Review record exists
per workspace profile and pull request from the first open onwards, and
`ReviewStore.list` already walks them.

## The decision

A fixed-width column left of `<main>` lists the pull requests the maintainer has
opened in the active workspace, most recently opened first. Clicking a row opens
that pull request. The column issues no GitHub request.

`GET /v1/sidebar/reviews?profileId=` is the whole data path.
`SidebarListingService.list` reads `ReviewStore.list` for that one profile,
sorts by the opened instant descending, and slices to `SIDEBAR_ROW_LIMIT`,
which is 20. A row carries the review id, `owner`, `repo`, the number, an
optional title, and the opened instant — nothing a GitHub read would supply.

A row shows `owner/repo` only when the listed rows span more than one
repository, and a record with no stored title falls under the same rule: its
label is `#number` when they all name one repository and `owner/repo#number`
when they do not. The rule reads the rows rather than the watchlist because
unwatching a repository leaves its records in place — only retention deletes
them — so its rows keep listing, and a bare `#412` beside another
repository's `#412` is the collision the label exists to prevent. The relative age is computed at render and
does not tick. The open pull request's row is highlighted, carries
`aria-current="page"`, and does nothing when clicked, because it is already
where navigation would land. The column collapses from a toggle in the header,
persisted as one local boolean.

The column follows prototype variant D2 in details the first cut of it dropped.
The age is compact — `4h`, `2d` — through a new `formatCompactRelativeTime`,
because a fixed-width column cannot spare `4 h ago`, and the exact instant is
on the `<time>` element's title. The header strip is back, carrying the active
workspace's label, and the native scrollbar is styled thin and low contrast,
because the shared `ScrollArea` draws a zero-width thumb here.

Every click routes through the existing `navigate()` guard, so a pending GitHub
write parks the destination behind the confirmation dialog exactly as it does
elsewhere. Routing from one workbench to another is now an ordinary gesture
rather than a rare one, so `performNavigation` keeps the held Review payload
only when the destination names the Review it already holds; it used to keep it
for any workbench destination, which rendered the previous pull request's diff
until the next one loaded.

The header workspace `Select` and the repository picker both stay. The Pull
requests table is still where new work is found; the column is where work is
resumed.

### This reinstates the listing ADR 0031 removed

ADR 0031 records a Local review listing that was built and then removed at the
maintainer's request, leaving the Repository listing as the Pull requests
screen's only source. This decision brings a local listing back, and is a
reversal of that removal rather than a way around it.

Two things are different. It sits beside the app frame instead of on the Pull
requests screen, so that screen still has one source and 0031's objection to
merging two of them is untouched. And it lists the pull requests the maintainer
has visited rather than a repository's open ones, so every row is answered from
a record already on disk. That is why it costs no GitHub call — and equally why
a pull request nobody has opened does not appear in it at all.

### `lastOpenedAt`, not `updatedAt`

`ReviewStore.list` already sorted by `updatedAt` descending, which looks like a
recents order and is not one.

Opening an existing Review did not save the record: `openUnlocked` projected the
record it loaded, and `load` never saves, so reopening a pull request left it
exactly where it was. Detect-updates, meanwhile, does save. It runs on workbench
mount, every 90 seconds, and on window focus (`use-review-observation.ts`), and
writes whenever GitHub has moved; boot-time journal recovery writes as well
(`review-observation-recovery.ts`). So `updatedAt` tracks activity on GitHub and
not the maintainer's own, and a pull request nobody has looked at in a week
floats to the top when someone comments on it.

`markReviewOpened` writes `lastOpenedAt`, and the workbench controller records
it in one place: `projectOpenedUnlocked`, which writes only once a projection
has come back. Every path that returns a projection therefore records the open,
and an open the maintainer was refused — a Terminal record turned away by
`openMerged`, or a projection that failed — records nothing and cannot rank a
pull request nobody reached. `title` rides the same write. `openUnlocked` takes
it from `ReviewSession.prContext.title`; `load` holds no session, so it fills a
missing title from the projection it already built. The save is best effort:
`ReviewStore.save` takes a compare-and-set token, and a lost race or any storage
failure is logged while the open continues with the record that was loaded.
Bookkeeping for a sidebar must never fail the open the maintainer asked for.

Restoring the last destination counts as opening it. The column navigates to the
workbench rather than opening a Review itself, so its own click arrives through
`load`, which makes `load` a maintainer's gesture and not boot bookkeeping.
Recording only on the `open` paths left the feature's primary click unable to
reorder the list it belongs to: clicking a row moved nothing.

Records written before this shipped have neither field. They fall back to
`updatedAt` for the sort and to the `#number` reference for the label, which is
why an old row keeps printing its number until the next time it is opened.

### The record schema stays at version 2

`reviewV2Schema` is pinned to `schemaVersion: 2` and there is no migration
framework, so bumping the literal would send every record already on disk to
quarantine. Both fields are `v.optional`, so version 2 parses records written
before and after this change.

The cost is one-directional, and is accepted rather than mitigated:
`reviewV2Schema` is a `v.strictObject`, so a build that predates these fields
refuses to parse a record this build writes. There is no downgrade path.

### No polling

ADR 0032 removed the refresh timer deliberately, on the argument that state
should not move under a reader. The column keeps that rule. It re-reads on a
workspace switch, through the `applyLatestProfileSwitch` teardown that already
exists and is exactly right for a list that only ever shows one workspace, and
on every Review open, because `openWorkbench` in `app.tsx` is the one funnel
every open path goes through. There is no timer.

### One unreadable record no longer blanks the list

`ReviewStore.list` gave up on the first record it could not read, so a single
corrupt file would empty a column that is meant to be always present. It now
skips that record and returns `{ reviews, unreadable }`. The count is a
diagnostic rather than a line in the column: `SidebarListingService` records it
as a `recovery` diagnostic and renders the rows it has. `insight-recovery.ts`
had the same defect and was fixed with it. The same failure has a second form
one layer up, where `SidebarListingService` projects a stored title of `""` as
no title at all: the renderer's row schema requires a non-empty string, so one
such record would fail the whole response parse and blank the column.

### Retention takes the record with the session

The retention sweep removed a session fourteen days after its pull request went
terminal and left the Review record behind, with `currentSessionId` pointing at
nothing. Without this column that was a latent fault; with it, the swept pull
request keeps a row that fails with a generic storage error on every click.
`ReviewStore.delete` removes the whole review directory under the same lock
`save` takes, and the sweep deletes the record before the session, so a failure
leaves the pair for the next sweep. The sweep iterates sessions, so a record
that outlived its session would never be revisited.

## Cut from v1

Each of these is built once there is evidence it is missed.

- **The workspace rail and the workspace home.** Both existed to replace a
  header workspace selector and a repository picker that are staying, so both
  would be a second route to something already two clicks away.
- **Cross-workspace rows.** They are what forced the rail, deleting
  `/v1/profiles/select`, and opening a Review outside the active workspace —
  four slices resting on one premise.
- **Archive.** A per-row hide for an annoyance nobody has reported, and the
  cause of the title truncation seen in the prototype.
- **The cap footer and its pinned row.** Opening a pull request makes it rank
  one, so it can never be the row pushed out of a 20-row cap.
- **Date group headers.** The evidence for them was twenty fixture rows drawing
  titles from a pool of eight, a harder scanning problem than real data.
- **Remote-derived state markers.** Nothing recomputes freshness without a
  GitHub call, so a marker here would report whatever was true the last time the
  pull request was opened. A marker that looks live and is not is worse than none.
- **The Insight chip.** Three file reads per row to render one dot.

## Consequences

- Nothing enters the column on its own. A pull request appears only after it has
  been opened once, so finding work that is new to the maintainer stays the Pull
  requests table's job.
- The column holds the twenty most recent visits in one workspace. There is no
  page past them and no archive; a finished pull request leaves by being pushed out.
- `ReviewStore.list` has no index — it opens every review file under the
  profile. The listing therefore runs on demand for one profile, and its cost
  grows with how many pull requests that workspace has ever opened.
- A row says nothing about merge state or checks, so a merged, closed, or
  conflicting pull request reads the same as an open one until it is opened.
- A row's title is written on open and never refreshed, so a pull request
  renamed on GitHub keeps its old title in the column until the next time it is
  opened, while the workbench header beside it already shows the new one.
- Arriving at a workbench mounts the Review loader twice, so two callers can
  wait on one in-flight stored-review load. Every waiter on an operation key is
  tracked now, because the answer used to be dropped when the run that started
  it had already gone, leaving the destination with no workbench to render and
  no second attempt to make.
- A record this build writes cannot be parsed by a build that predates `title`
  and `lastOpenedAt`.
- The retention sweep now deletes Review records. Fourteen days after a pull
  request goes terminal its record, Insights, and journals go together, and
  opening it again starts a fresh Review.
