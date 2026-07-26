---
created_at: 2026-07-25
repos: patchdesk
status: approved-design
sources:
  - ../review-run-lifecycle/spec.md
---

# Session quarantine and storage management

## Problem

Schema drift makes old stored sessions unreadable. When a stored session no
longer parses, Patchdesk today:

1. **silently drops it** from `listSessions` — the user cannot see it or
   discard it; and
2. **refuses to prepare the PR** — `prepareSerialized` maps any load failure
   other than `not_found` to `SessionStorageUnavailable`, so the renderer
   shows "Could not prepare <pr>" forever, with no in-app recovery.

Observed 2026-07-25: PR `centraldigital/cfw-bo-staff-api#717` could not be
opened because its Jul-23 saved review contains a finding with
`lineStart 194, lineEnd 216`; the current `projectFinding` rule rejects spans
over 10 lines (`src/domain/review-result.ts`). The session was written by an
older build, before the rule existed. Three more sessions are unreadable for
legacy-schema reasons (`cfw-bw-sale-api` pr-1003 v1, pr-1184 pre-versioning,
one customer-management pr-118 v1), and an orphaned worktree exists for
pr-1110 with no session at all. The review-worktree cache was ~700 MB with no
user-facing way to clear it.

## Design

Two workstreams: automatic quarantine (A) and visible storage management (C).
Migration-on-read leniency (e.g., clamping long finding ranges when reading
stored results) is deliberately deferred — quarantine preserves the data on
disk, and per-rule leniency is ongoing tax we only need if users ask for old
reviews to stay openable.

### A. Quarantine on invalid stored session

When `ReviewSessionPreparation.prepareSerialized` finds the stored session
unreadable (`invalid_stored_value`, any operation):

1. Rename the session directory
   `<data>/profiles/<p>/reviews/<id>` → `<data>/profiles/<p>/reviews/.quarantine/<id>.<yyyymmddThhmmss>`.
2. Rename its cache worktree the same way
   `<cache>/profiles/<p>/review-worktrees/<id>` →
   `<cache>/profiles/<p>/review-worktrees/.quarantine/<id>.<yyyymmddThhmmss>`
   (absent worktree is fine — pr-1110 proved orphans exist).
3. Continue with a completely fresh preparation.

Rules:

- Quarantine never deletes; it only renames. Deletion is the user's action in
  workstream C.
- If the quarantine rename itself fails, keep today's honest
  `SessionStorageUnavailable` error — never prepare over data we could not
  move aside.
- `listSessions` and every other reader must ignore `.quarantine/` (they
  already skip unparseable entries; make the skip explicit and tested).
- Only `invalid_stored_value` triggers quarantine. I/O errors, permission
  failures, and `not_found` keep their current behavior — a transient read
  error must not hide a session.
- The fresh prepare reuses the same session id; because the old worktree was
  also quarantined, `worktrees.prepare` builds a clean one instead of reusing
  a stale checkout.

### C. Storage management in Settings

New "Storage" section in the settings flow:

1. **Saved reviews list.** Every session for the active profile: PR label,
   state, updatedAt. Sessions in `Created`, `ReviewFailed`, `ReviewCompleted`,
   or `Stale` state get a **Discard** action; `Running` sessions show state
   only (discard would orphan a live run). Discard transitions the session to
   the existing `Discarded` domain state and removes its cache worktree; the
   session file stays on disk for history.
2. **Older-version entries.** Quarantined directories listed as
   "Saved review from an older version — can't be opened" with a **Delete**
   action that moves the quarantined session dir (and worktree) to the system
   Trash. This is the only deletion in the feature and it requires an
   explicit click per entry.
3. **Review cache.** Shows the size of
   `<cache>/profiles/<p>/review-worktrees` and a **Clear cache** button.
   Clearing removes worktree directories not referenced by a `Running`
   session, then runs `git worktree prune` in each profile repo `localPath`.
   Worktrees are rebuildable, so clearing is always safe; running sessions
   are excluded by rule.

All three capabilities are main-process services behind the local API with
the renderer as a thin client, matching the existing layering
(`src/domain/` → `src/services/` → `src/adapters/`). New routes are read-only
except the explicit Discard/Delete/Clear actions, which take per-entry
confirmation in the UI. No GitHub writes are introduced anywhere.

## Boundaries

- Quarantine renames; it never deletes. Deletion requires the explicit
  per-entry Delete in Settings.
- Running sessions are never discarded, deleted, quarantined, or cache-cleared.
- Startup reconciliation semantics are unchanged (`ReviewFailed` on orphans).
- `runId` stays process-local; the safe-run projection boundary is untouched.

## Testing

- Unit: quarantine path in preparation (invalid session → fresh prepare,
  old dirs moved, `.quarantine` excluded from listing); rename-failure keeps
  `SessionStorageUnavailable`; discard service transitions state and removes
  the worktree; cache-clear preserves `Running` worktrees and prunes
  registrations.
- Renderer: settings storage section renders sessions, quarantined entries,
  and cache size; Discard/Delete/Clear require confirmation.
- Gate: `pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build &&
  pnpm exec playwright test`, then packaged QA via the `electron-tester`
  subagent (verify a broken session opens fresh, discard works, cache size
  drops).

## Implementation issues

- `issues/01-quarantine-on-invalid-session.md` — workstream A
- `issues/02-storage-services-and-routes.md` — discard/delete/clear services + local API routes
- `issues/03-settings-storage-section.md` — settings UI
