# Recover from invalid local data by rebuilding

> **Status: Accepted.** Extends the fail-closed posture of ADR-0013: Patchdesk stays the authority over local review state, but invalid stored data is never a blocker.

Patchdesk treats local stored data as a rebuildable cache of the pull request authority. When stored data fails schema validation, Patchdesk recovers by rebuilding from the pull request instead of refusing to load.

Three artifact classes follow this rule:

- An invalid Insight record (Analysis or Walkthrough) is ignored and reads as not generated. The review opens normally; a re-run overwrites the record and heals it.
- An invalid Review record is moved aside under a timestamped quarantine entry and the review is rebuilt fresh from its pull request identity. The review id is identity-derived, so it stays the same.
- Invalid session artifacts are moved aside and the session is re-prepared.

Quarantine is only the move-aside step before a rebuild. It is never a blocking outcome. Quarantine entries stay recoverable on disk until the retention sweep removes them (ADR-0020).

Patchdesk still fails closed for genuine storage failures: unreadable files, I/O errors, and unknown conditions. Only invalid stored values trigger the rebuild path. The distinction is deliberate: invalid data means a schema drift or a corrupted write, and the authoritative source is the pull request; an I/O failure means the machine cannot operate at all.

## Consequences

- A review always opens when GitHub is reachable, even after an upgrade drifts a stored schema.
- Local history of a rebuilt review is lost. The moved-aside quarantine keeps it recoverable manually.
- The recovery path is exercised only on invalid data, so a healthy install never touches it.
