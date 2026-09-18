# Recover from invalid local data by rebuilding

> **Status: Accepted.** Extends the fail-closed posture of the ADR "Keep model runs bounded and non-authoritative": Patchdesk stays the authority over local review state, but invalid stored data is never a blocker.

Patchdesk treats local stored data as a rebuildable cache of the pull request authority. When stored data fails schema validation, Patchdesk recovers by rebuilding from the pull request instead of refusing to load.

Three artifact classes follow this rule:

- An invalid Insight record (Analysis or Walkthrough) is ignored and reads as not generated. The review opens normally; a re-run overwrites the record and heals it.
- An invalid Review record is moved aside under a timestamped quarantine entry and the review is rebuilt fresh from its pull request identity. The review id is identity-derived, so it stays the same.
- Invalid session artifacts are moved aside and the session is re-prepared.

Quarantine is only the move-aside step before a rebuild. It is never a blocking outcome. Quarantine entries stay recoverable on disk until the retention sweep removes them (see the ADR "Retain only live reviews and recent history").

Patchdesk still fails closed for genuine storage failures: unreadable files, I/O errors, and unknown conditions. Only invalid stored values trigger the rebuild path. The distinction is deliberate: invalid data means a schema drift or a corrupted write, and the authoritative source is the pull request; an I/O failure means the machine cannot operate at all.

## Consequences

- A review always opens when GitHub is reachable, even after an upgrade drifts a stored schema.
- Local history of a rebuilt review is lost. The moved-aside quarantine keeps it recoverable manually.
- The recovery path is exercised only on invalid data, so a healthy install never touches it.

## Update (2026-09-17): the recent-write journal

The recent-write journal (`recent-writes.json` in a Review's directory) is a fourth artifact class under this rule, and the first with no authoritative source to rebuild from. Two things set it apart from the other three:

- It rebuilds empty rather than from the pull request. Its only job is suppressing a duplicate observation of a write Patchdesk just made, so losing it costs one redundant refresh. An invalid journal is moved aside and the next read starts an empty one.
- Its quarantine copy is a single fixed-name file, `recent-writes.quarantine.json`, beside the journal and outside the retention sweep. The next quarantine overwrites it, so a Review keeps at most one copy, and it goes when the Review's directory goes.

For the same reason a journal write is never fatal: once GitHub has confirmed a write, a failed journal append is logged and the write still releases its operation record and the write lock (ADR "Reconcile every uncertain GitHub write").
