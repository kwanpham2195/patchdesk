# Retain only live reviews and recent history

> **Status: Proposed.** Pending implementation of the retention sweep (`.agents/specs/2026-08-16-retention-sweep/`).

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
