# Settings storage section

Type: task
Status: needs-triage

New "Storage" section in the settings flow consuming the routes from
issue 02:

- Saved reviews list (PR label, state, updatedAt) with per-entry Discard for
  non-Running sessions, behind a confirmation.
- Older-version (quarantined) entries with per-entry Delete-to-Trash behind a
  confirmation.
- Review cache size with a Clear cache button behind a confirmation.

Copy must be honest about what each action does: Discard keeps the session
file and removes the checkout; Delete moves the quarantined copy to Trash;
Clear cache only removes rebuildable worktrees and never touches sessions or
GitHub.

Spec: `../spec.md` (workstream C). Blocked by: 02.

## Comments
