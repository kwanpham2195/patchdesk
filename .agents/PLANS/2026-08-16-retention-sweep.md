---
created_at: 2026-08-16
repos:
  - patchdesk
status: implemented
---

# Tech Spec: Automatic storage retention sweep

## Problem

Patchdesk is local-first. It stores review sessions, git worktrees, and
quarantine entries on disk. Today, only logs are bounded automatically
(5 MB per file, 3 rotated files kept). Everything else grows without limit:

- Review sessions under `profiles/<profile>/reviews/<sessionId>/`
- Git worktrees under `~/.cache/patchdesk/profiles/<profile>/review-worktrees/`
- Quarantine entries under `profiles/<profile>/{workbenches,reviews}/.quarantine/`

Measured on the CFW QA profile after a few weeks of use:

- Worktrees: 127 MB (the dominant and riskiest class; a worktree is a full
  repo checkout, so large repos can make each worktree hundreds of MB to GB)
- Logs: 9.2 MB (already bounded by rotation)
- Sessions: 2.4 MB
- Quarantine: 2.2 MB

No retention policy exists. The only cleanup is manual via the storage panel
(`/v1/storage/*`). A merged PR's session and worktree stay on disk forever.

## Goals

- Bound disk usage to live reviews plus recent history, with no user action.
- Keep the existing safety invariant: cleanup removes only non-running
  review sessions.
- Keep all existing manual storage actions unchanged.

## Non-goals

- Delete open-review sessions. A saved open review stays restorable.
- Shrink worktrees in place.
- Change log rotation.

## Design

One automatic sweep runs after the local API starts, and again once per
24 hours while the app runs. It is fire-and-forget and never blocks startup
or review loading.

### Retention rules

Terminal review sessions and their worktrees are removed when all of the
following hold:

- The review record exists and its status is `Terminal` (merged or closed).
- The session is older than 14 days (by `updatedAt`).
- No running state is attached to the session.

A session whose review record is missing (orphaned) is removed when it is
older than 14 days and has no running state.

Quarantine entries are removed when they are older than 30 days (by the
timestamp in the entry name).

### Safety

The sweep reuses the existing protection checks, with one deliberate change:

- Today, `isProtected` shields the current session of any review, including
  terminal reviews. The sweep must discard terminal sessions anyway, because
  the review state lives on GitHub and reopening rebuilds the session.
- The running-state checks are extracted into `isRunningState` and always
  apply:
  - An active preparation journal entry for the session.
  - An active insight run (analysis or walkthrough) attached to the session.
  - A write in flight or outcome unknown for the pending review or direct
    summary.
  - The session belongs to the current session of an open review.

The whole sweep runs under the existing per-profile lock
(`withProfileLock`), so it cannot race an open or a preparation.

### Constants

- `RETAIN_TERMINAL_SESSIONS_MS = 14 days`
- `RETAIN_QUARANTINE_MS = 30 days`

## Algorithm

```text
on(sweepRetained, now)
  withProfileLock(profileId)
    for session in sessions.listSessions(profileId)
      if isRunningState(session)
        continue
      review = reviews.load(profileId, createReviewId(session.key))
      discardable =
        review is not_found
        or review.status is Terminal and session.updatedAt < now - 14d
      if discardable
        artifacts.removeSession(profileId, session.id)
        diagnostics.record(reason: "retention_sweep", ...)
    for entry in artifacts.listQuarantined(profileId)
      if entry.quarantinedAt < now - 30d
        artifacts.removeQuarantined(profileId, entry.entryName)
        diagnostics.record(reason: "retention_sweep", ...)
```

`removeSession` already deletes the session directory and its paired
worktree. `removeQuarantined` already deletes a quarantine entry and its
paired worktree.

## Failure handling

- Any storage error in a single item is recorded as a diagnostic and the
  sweep continues with the next item. The sweep never fails startup.
- If the sweep cannot acquire the profile lock, it skips that profile and
  retries on the next scheduled run.
- Removal uses the existing verified-path helpers only. The sweep never
  performs broad filesystem deletion.

## Testing plan

Unit tests in `tests/services/storage-management-service.test.ts`:

- Terminal session older than 14 days is removed (session and worktree).
- Terminal session younger than 14 days is kept.
- Open review session is kept.
- Session with an active preparation journal is kept.
- Session with an active insight run is kept.
- Session with a write in flight is kept.
- Orphaned session older than 14 days is removed.
- Quarantine entry older than 30 days is removed.
- Quarantine entry younger than 30 days is kept.
- A storage error on one item does not stop the sweep.

Verification on the real surface:

- Run the app, confirm the sweep logs a diagnostic with zero removals.
- Prepare a fixture session, backdate its `updatedAt`, mark the review
  terminal, restart, confirm removal and the diagnostic.

## Rollout

- Land the sweep as one commit with its tests.
- Observe one week of diagnostics in the local log before considering
  any tuning of the windows.

## Open questions

- Should the retention windows be user-configurable in settings? Default:
  no; fixed constants keep the surface small. Revisit if users ask.
