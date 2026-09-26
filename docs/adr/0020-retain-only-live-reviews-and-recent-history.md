# Retain only live reviews and recent history

> **Status: Accepted.** Implemented with the retention sweep.

Patchdesk bounds local disk usage with an automatic retention sweep. The sweep runs after the local API starts and once per 24 hours while the app runs. It removes only data that the pull request authority can rebuild.

The sweep removes:

- Sessions and their paired git worktrees when the review is terminal (merged or closed) and the session is older than 14 days.
- Orphaned sessions older than 14 days.
- Quarantine entries older than 30 days.

The sweep never removes:

- The current session of an open review.
- Any session with running state: an active preparation journal, an active insight run, or a write in flight or outcome unknown.

This changes one protection from the pre-sweep posture: the current session of a terminal review is no longer shielded by the current-session rule. The running-state checks always apply and are extracted into a shared helper so the sweep and the manual storage panel use the same definition of "running".

Retention windows are fixed constants in the first version. They may become user-configurable later if users ask.

## Consequences

- Disk usage stays bounded to live reviews plus the retention windows, with no user action.
- Reopening a terminal review rebuilds its session from the pull request. Local insight history for a discarded session is gone.
- The manual storage panel keeps working alongside the sweep; both use the same running-state definition.

> **Note, 2026-09-26 (#474):** local Reviews (ADR 0050) are never terminal, so the rules above kept every session one ever had, each with a worktree and a `refs/patchdesk/local` ref in the maintainer's repository. As built:
>
> - Each time a local Review moves to a session on open or Refresh, and in the scheduled sweep, every superseded session is removed with its worktree and managed ref, unless it has running state. The move that confirms an Apply skips this, because its Apply operation record still exists; the next open, Refresh, or sweep removes the session it moved past. A session that a retained Analysis, Walkthrough, or Brief names keeps its session record and patch and loses only its worktree and ref; returning to that snapshot checks the worktree out again. A Review with a recorded Apply operation is left alone.
> - A local Review is removed with its sessions and Insights when its repository still reads, its branch, base branch, or commit no longer exists, it has no Local drafts, and it was last opened over 14 days ago. A detached working-tree Review is kept.
> - An active Brief run now counts as running state, as an Analysis or Walkthrough run does.
> - Removing a worktree now deletes the managed refs it checked out. Discard, Clear local review data, and the pull request sweep remove session directories without Git, so their refs stay until the scheduled sweep deletes every managed ref of the profile that no stored session, worktree, or preparation names. That deletion refuses a ref that moved after it was listed. Git's records of those worktrees stay until the next `git worktree prune`, which runs before each new session worktree is added.

> **Note, 2026-09-26 (#478):** an Open pull request Review kept every session it moved past after a push until it became Terminal. The superseded-session rule of the #474 note now covers every Open Review, local or pull request. As built:
>
> - A Refresh that moves a pull request Review to a new session prunes the ones it moved past under the Review lock it already holds; a Refresh that keeps the session prunes nothing. The background sweep prunes every Open Review.
> - A superseded session is kept while it has running state. A session a retained Insight names keeps its record and patch and loses its worktree and refs.
> - A Review keeps every session while it has a recorded GitHub write operation, or while any of its sessions holds an in-flight or outcome-unknown pending-review or summary write, so ADR 0035 recovery finds what it reads.
> - A Terminal Review is not pruned; the 14-day rule above removes it.
> - When the profile no longer names the repository's checkout, a superseded session with a worktree is kept, since only Git can remove the worktree; one without a worktree is removed.
