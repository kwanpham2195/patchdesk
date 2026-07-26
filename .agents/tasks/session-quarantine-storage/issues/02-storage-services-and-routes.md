# Storage services and local API routes

Type: task
Status: needs-triage

Main-process services behind the local API:

1. Session listing for settings: all sessions for a profile with PR label,
   state, updatedAt, plus quarantined `.quarantine/` entries marked as
   "older version — can't be opened".
2. Discard: transition a non-Running session to the existing `Discarded`
   domain state and remove its cache worktree.
3. Delete quarantined: move one quarantined session dir and its worktree to
   the system Trash (per-entry, explicit).
4. Cache info + clear: size of `<cache>/profiles/<p>/review-worktrees`;
   clear removes worktree dirs not referenced by a Running session, then
   `git worktree prune` in each profile repo `localPath`.

Renderer stays a thin client; all writes are explicit routes, none touching
GitHub.

Spec: `../spec.md` (workstream C).

## Comments
