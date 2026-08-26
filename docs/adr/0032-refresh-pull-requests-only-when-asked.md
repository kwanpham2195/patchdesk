# Refresh the pull requests screen only when asked

> **Status: Accepted. Implemented in `ad02438..HEAD` on `main`** —
> `InboxRefreshScheduler` and its focus polling, backoff ladder, and rate-limit
> wait are gone; refresh happens only when the maintainer asks. Companion to
> ADR 0031, which scopes the screen to one repository. Terms in bold are
> defined in `CONTEXT.md`.
>
> **The freshness badge is the in-app refresh target.** This was left
> unsettled when the polling was removed, leaving refresh reachable only from
> the View menu. Settled here: the badge is a button that asks for a refresh,
> and is disabled while a read is already in flight. It puts the command next
> to the state it acts on rather than adding a second control beside it, and
> it does not weaken this ADR — the badge never refreshes itself, it only lets
> the maintainer ask.

The Pull requests screen polls. `InboxRefreshScheduler`
(`src/renderer/src/inbox-refresh-scheduler.ts`) refreshes every sixty seconds
while the window has focus, backs off through a `[60s, 120s, 240s, 300s]`
ladder after failures, waits out a rate limit until a learned resume time, and
suspends itself when the window loses focus. `app.tsx` feeds it
`allRepositoriesRateLimited` and `maxResumeAt`, which collapse every watched
repository's state into one decision about whether to slow the whole poll.

Every other surface in Patchdesk works the opposite way. ADR 0001, "Keep GitHub
refresh explicit", states the rule: Patchdesk represents the GitHub state from
the maintainer's latest refresh, and applies remote changes when the maintainer
asks. The Review workbench obeys it. The Pull requests screen is the exception.

## The decision

The Pull requests screen refreshes only when the maintainer asks, or when it has
to fetch anyway. There is no timer.

Three triggers remain, and two of them already exist:

- Opening the screen. The initial fetch goes through the ordinary request path,
  not the scheduler.
- Changing anything that alters the query — a filter, a page, or the page size.
  These already re-request.
- **View → Refresh**, a real menu item carrying `CommandOrControl+R`.

`InboxRefreshScheduler` is deleted, along with the sixty-second timer, the retry
ladder, the rate-limit-aware scheduling, the `Paused` freshness state, and
`allRepositoriesRateLimited` and `maxResumeAt` in `app.tsx`.

`inboxFreshnessLabel` and `formatInboxAge` are kept. They are what make this
honest: a screen that only refreshes on request owes the maintainer a plain
statement of how old what they are reading is. The badge and the manual trigger
are one feature, not two.

Refresh is a menu item rather than a renderer key handler because this app
already puts app-level shortcuts in the menu — Settings is there with
`CommandOrControl+,`. A menu item behaves identically in development and in a
packaged build, and it is discoverable by opening the menu instead of being
guessed. The development-only `{ role: "reload" }` moves to
`CommandOrControl+Shift+R` to free the accelerator.

## Why

Polling is the largest single source of GitHub traffic in Patchdesk: once a
minute, multiplied by every watched repository. ADR 0023 exists to survive the
rate limits that traffic causes. Removing the timer removes most of the pressure
rather than managing it.

The consistency argument is the stronger one. ADR 0001 already decided that
Patchdesk shows what it last fetched and the maintainer decides when to update.
Applying that to the one surface that ignored it is not a new position; it is
finishing an old one.

The replacement cost is near zero because the screen already refetches on open
and on every query change. What a timer adds beyond that is data changing while
the maintainer is reading it — which is the thing ADR 0001 set out to prevent.

## Rejected alternatives

**Keep polling, but only for one repository.** Under ADR 0031 a refresh is one
GraphQL call rather than a fan-out, so the traffic argument weakens. Rejected on
consistency instead: a cheaper timer is still a timer, and still moves state
under a reader. The cost was never the only objection.

**Keep refresh-on-focus and drop only the timer.** `setForeground(true)` already
refreshes immediately, so this was nearly free, and it covers the common case of
returning to the app after pushing a commit. Rejected because it keeps a
refresh the maintainer did not ask for, on a trigger they cannot see, to save a
single keystroke.

**Pull to refresh.** Rejected. It is unreachable by keyboard, so the menu item is
still required and the gesture becomes a third path to one action. It works only
when the list is scrolled to the top. Trackpad overscroll would fire refreshes
nobody asked for, in a design whose whole point is that refreshes are asked for.
And a refresh here re-runs the query and replaces the page, so the content would
jump under the gesture that caused it. It would suit a newest-first feed where
new rows prepend and reading position survives. This is not that.

## Consequences

- A maintainer who leaves the screen open sees data age. The freshness badge
  reports it, and that badge is now load-bearing rather than decorative.
- Nothing announces a newly opened pull request. Finding out requires refreshing
  or opening the screen. Notifying is GitHub's job, not Patchdesk's.
- This supersedes the scheduler half of ADR 0023. The resume time is still
  learned on every refresh, so the per-host rate-limit cache still fills and
  every other GitHub call still reads it. What goes is the scheduler that
  honoured that time by waiting — there is no longer anything waiting.
- ADR 0023's distinction between one rate-limited repository and all of them
  disappears with `allRepositoriesRateLimited`. Under ADR 0031 there is only one
  repository, so the distinction had no meaning left.
- Removing the header's refresh control reclaims that space. Making the freshness
  badge itself the click target is the obvious form and should be settled during
  implementation.
