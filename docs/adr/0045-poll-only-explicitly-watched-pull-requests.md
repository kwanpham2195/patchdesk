# Poll only explicitly watched pull requests

> **Status: Accepted.** Issue #226. Supersedes in part ADR 0032: its "a
> cheaper timer is still a timer" rejection and its "Notifying is GitHub's
> job" consequence. Amends ADR 0044 with one event kind. ADR 0032's rule for
> the Pull requests screen and the Review workbench is unchanged.

A reviewer who requested changes waits for the author's fix, and an author
waits for a decision or a CI result. Patchdesk refreshes only when asked (ADR
0032), so both have to come back and press Refresh to find out whether
anything happened.

## The decision

The maintainer can **watch** a pull request from the Pull requests inspector,
the Review header, or the ⌘K palette. A watched pull request is polled while
the app runs, and each change posts one desktop notification through ADR
0044's notifier. Nothing else refreshes.

Only an open pull request can be newly watched. The service reads the baseline
before saving the watch and refuses a merged or closed baseline. A terminal
pull request already in storage keeps the existing poll behavior, which sends
its final notification and removes the watch.

**What is compared.** Each watched pull request stores a snapshot: `updatedAt`,
head sha, review decision, CI rollup, and open, merged, or closed. It is read
from GitHub when the watch is made and replaced after each poll. A poll
compares GitHub's answer with the stored snapshot and derives one event per
change:

- merged or closed, reported alone, after which the pull request is unwatched;
- pushed, which also covers the CI rollup of the new head;
- review decision changed;
- CI rollup changed;
- commented, when `updatedAt` moved and nothing above changed. Any other
  activity GitHub dates, such as a label edit, reads the same.

The stored snapshot is the baseline, so a restart never repeats a
notification, and notifications post only after the new snapshots are saved.

**One call.** A profile watches at most 20 pull requests, and one poll is one
aliased GraphQL query over all of them: twenty aliases cost one rate-limit
point and twenty nodes (checked live on 2026-09-17). A 21st watch is refused
with `WatchLimitReached` before GitHub is asked.

**When it runs.** Once at start, then every 1, 3, 5, or 10 minutes from
Settings → General → Notifications, default 3. The interval is read at start,
so a change applies at the next launch. A tick is skipped while notifications
are off, for a profile whose Review holds a GitHub write or write recovery,
and while the host's last response spent the whole rate limit. A failed tick
waits for the next one; there is no backoff.

**What it may change.** Notifications, and a dot on the Pull requests
freshness badge until the next refresh. It never replaces a row, a Review
session, a diff, or any other displayed state. That is the answer to ADR
0032's objection: the objection to a timer was state moving under a reader,
and this timer moves none.

**Silence.** A change to a watched pull request whose Review is on screen in
the workbench posts nothing, focused or not: the workbench's own freshness
check reports the change there.

## Why

Watching is an explicit act, so the poll covers only pull requests the
maintainer asked about. That keeps traffic to one call per profile per tick
and removes any "which events matter" heuristic. Notifying is still GitHub's
job for everything else; a maintainer who watched a pull request has asked
Patchdesk to do it for that one.

## Consequences

- A watched pull request stays watched when its repository leaves the
  workspace watchlist: the poll reads by pull request reference.
- A watched pull request GitHub can no longer resolve, such as one in a
  repository the account lost access to, fails the whole aliased query for
  that profile until it is unwatched.
- Profiles are read when the local API starts, so a profile created during a
  session is polled from the next launch.
- The `watched-pull-requests` debug log writes `polled` with the notification
  count, and `skipped` with `disabled`, `write_active`, the GitHub failure, or
  the storage failure.
