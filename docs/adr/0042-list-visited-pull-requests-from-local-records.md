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
sorts by the ordering instant descending, and slices to `SIDEBAR_ROW_LIMIT`,
which is 20. A row carries the review id, `owner`, `repo`, the number, an
optional title, the instant it is ordered and grouped by, and — only where
Patchdesk recorded one — the last open. Nothing a GitHub read would supply.

A row names the repository only when the listed rows span more than one, and
names the owner only when they span more than one owner; a record with no
stored title falls under the same rule, so its label is `#number`,
`repo#number`, or `owner/repo#number` as the rows require. The rule reads the
rows rather than the watchlist because unwatching a repository leaves its
records in place — only retention deletes them — so its rows keep listing, and
a bare `#412` beside another repository's `#412` is the collision the label
exists to prevent. The owner is a separate cut because it is the expensive
half: on a workspace where every row sits under one owner, `centraldigital/`
was roughly half the line, distinguished nothing, and pushed the age off a
titled row's meta line. The relative age is computed at render and
does not tick. The open pull request's row is highlighted, carries
`aria-current="page"`, and does nothing when clicked, because it is already
where navigation would land. The column collapses from a toggle in the header,
persisted as one local boolean.

The column follows prototype variant D2 in details the first cut of it dropped.
The age is compact — `4h`, `2d` — through a new `formatCompactRelativeTime`,
because a fixed-width column cannot spare `4 h ago`, and the exact instant is
on the `<time>` element's title. It counts elapsed time all the way up and
names no calendar day, because the date header above the row already answers
that question and the two answers disagree across local midnight: twenty-six
elapsed hours can sit under `THIS WEEK`, where a row reading `yesterday` would
contradict the header it is filed under. One line does not answer the same
question twice. The header strip is back, carrying the active workspace's
label, and the native scrollbar is styled thin and low contrast, because the
shared `ScrollArea` draws a zero-width thumb here.

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

### Date group headers, cut and then reinstated

The rows carry `TODAY`, `YESTERDAY`, `THIS WEEK`, and `EARLIER` headers,
inserted where the bucket changes in the order the route already returned. The
first cut of the column dropped them, on the argument that the evidence for
them was twenty fixture rows drawing titles from a pool of eight, a harder
scanning problem than real data. Real data on a real workspace reversed it:
with the maintainer's own visits in the column the grouping earned its line,
and the fixture argument turned out to be an argument about the fixtures.

The boundaries are whole calendar days measured from the maintainer's local
midnight, deliberately not the prototype's UTC floor. At UTC+7 a pull request
opened an hour ago sits on the previous UTC day for most of the working day, so
a UTC floor would head it Yesterday. `visitedDateGroupLabel` therefore compares
local calendar days rather than elapsed hours, which is also why a pull request
opened this morning reads Today whatever the hour. The headers are not sticky,
and a bucket holding no row is never named: the label is computed per row and
only the row that opens a bucket carries one, so nothing is sorted, nothing is
dropped, and a column whose rows were all opened today shows one header.

### Dated state markers, cut and then reinstated

A row whose pull request is merged or closed carries `Merged · seen 3d` or
`Closed · seen 12d`, right-aligned on the meta line and coloured from a plain
function — the informational tone for merged, which is the ordinary end of a
review, and the destructive tone for closed, which ended without the change
landing. An open pull request carries nothing.

The rule that cut them still holds and is now satisfied rather than waived:
a marker here is dated or absent, because nothing in this column recomputes
freshness and a marker that looks live and is not is worse than none. The date
costs nothing to have. `ReviewStatus`'s `Terminal` variant already carries its
own required `observedAt`, validated by `reviewV2Schema` and loaded with the
record, so `SidebarListingService` projects the state and its date out of what
`ReviewStore.list` has already read: no GitHub call and no second file read.
`updatedAt` would have been the wrong field to date the marker with, because
unrelated writes bump it — detect-updates saves whenever GitHub has moved — so
it dates the last write to the record rather than the observation.

The word is "seen" because that is the whole claim. Three of the four sites
that write `observedAt` stamp it from Patchdesk's own clock next to the
confirming GitHub read: `ReviewObservationService`'s `now()`, the merge write
controller's `startedAt`, and `ReviewRefreshService`'s `refreshedAt`. The
fourth is `ReviewRecoveryService`, which stamps GitHub's own `mergedAt` for a
merge and Patchdesk's clock for a close, so on that one path the marker dates
GitHub rather than Patchdesk: a merge whose outcome was lost and reconciled at
the next boot can read `Merged · seen 3d` for something Patchdesk learned
minutes ago. Everywhere else the marker says when Patchdesk saw the state, not
when GitHub reached it. Either way the date is a first sighting rather than a
running one — `ReviewObservationService`'s `observeUnlocked` returns early on a
Terminal record, so a stored state is never observed again and its date never
moves.

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
it in two: `createFreshReview` stamps the record it is creating, and
`projectOpenedUnlocked` writes only once a projection has come back. A Review
Patchdesk had to restart comes through the first, so it projects stably rather
than stamping a second time under a fresh clock. Every path that returns a
projection therefore records the open exactly once, and an open the maintainer
was refused — a Terminal record turned away by `openMerged`, or a projection
that failed — records nothing and cannot rank a pull request nobody reached. `title` rides the same write. `openUnlocked` takes
it from `ReviewSession.prContext.title`; `load` holds no session, so it fills a
missing title from the projection it already built. The save is best effort:
`ReviewStore.save` takes a compare-and-set token, and a lost race or any storage
failure is logged while the open continues with the record that was loaded.
Bookkeeping for a sidebar must never fail the open the maintainer asked for.

Restoring the last destination counts as opening it, and so does the column's
own click: the column navigates to the workbench rather than opening a Review
itself, so both reach `load` through `openStoredReviewById`. Recording only on
the `open` paths left the feature's primary click unable to reorder the list it
belongs to: clicking a row moved nothing.

`load` is not only those two, though. Five more callers reach it — the reload
after a publish, the reload after a merge, the reload when an Insight run
finishes, and the two server-side recovery routes — and every one of them
re-reads a workbench that never left the screen. Recording those reordered the
column for something the maintainer had not opened. The request therefore
carries an explicit `recordOpen`, set only by the caller that is a real open;
the other five reload the workbench and stamp nothing. The claim belongs to the
caller because the renderer knows which request it is making and the controller
cannot tell. It has to be this exact: the field is called `lastOpenedAt` and the
column prints it under a header reading "recent", so it has to mean an open.

Records written before this shipped have neither field, and a row carries two
instants for their sake. `sortedAt` is what the column orders and date-groups
by, and still falls back to `updatedAt`; `lastOpenedAt` is the recorded open,
and the printed age is drawn from that alone, so a row with no recorded open
prints no age at all. Such a row also falls back to the `#number` reference for
its label, which is why it keeps printing its number until the next time it is
opened.

The two are separate because `updatedAt` is GitHub's activity rather than the
maintainer's: on a workspace whose records predate this branch, 13 of 20 rows
printed an `openedAt` equal to the terminal `observedAt` to the millisecond — a
merge observation wearing a visit's clothes. Ordering keeps the fallback, since
ordering is a guess and a printed age is a claim.

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

Each of these is built once there is evidence it is missed. Date group headers
and remote-derived state markers were on this list and have come off it; both
are in the decision above, with what changed the answer.

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
- A row says whether its pull request merged or closed and when Patchdesk last
  saw that, but nothing about checks, so a pull request whose checks have gone
  red or which no longer merges reads the same as one that is fine until it is
  opened. The state marker is only as current as the last observation: a pull
  request merged on GitHub since it was last opened still reads as open here.
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
