---
name: write-safety
include:
  - "src/adapters/storage/**"
  - "src/adapters/github/github-thread-writer.ts"
  - "src/adapters/github/github-pending-review.ts"
  - "src/adapters/github/github-write-failures.ts"
  - "src/adapters/github/github-request.ts"
  - "src/adapters/github/github-http-client.ts"
  - "src/domain/github-write.ts"
  - "src/domain/github-write-refusal.ts"
  - "src/domain/review-write-operation.ts"
  - "src/domain/recent-review-write.ts"
  - "src/domain/keyed-mutex.ts"
  - "src/services/*-write-*.ts"
  - "src/services/*-recovery*.ts"
  - "src/services/*-operation*.ts"
  - "src/services/*-journal.ts"
  - "src/services/*-coordinator.ts"
  - "src/services/*-gate.ts"
  - "src/services/pull-request-metadata-write.ts"
  - "src/services/refused-write-settlement.ts"
  - "src/services/merge-write-controller.ts"
---

Review changed lines on storage, GitHub-write and locking paths. Rules come from `docs/adr/0035-reconcile-every-uncertain-github-write.md` and `AGENTS.md` (Implementation notes).

Questions:

1. Rejected vs unknown: is a write marked `rejected` only on a refusal GitHub actually returned? Network errors, timeouts, 5xx and unparseable success bodies must be outcome-unknown and keep the operation locked for reconciliation.
2. Recovery evidence: does recovery match by body and anchor (exact creation or reply match, intended thread state or edited body, confirmed absence for deletion)? "Any comment created after" is wrong. Recovery must never repeat the mutation.
3. Confirmed stays confirmed: if a bookkeeping step after a confirmed write fails (journal append, cache write, observation), is it logged and swallowed, never re-locking or re-offering the write?
4. Intent ordering: is the write intent persisted before the mutation starts, marked outcome-unknown right before the network call, and confirmation persisted before success is reported?
5. Locking: does a new write path go through the Review coordinator / write gate / `keyed-mutex.ts` rather than bypassing it? Can two writers interleave on the same key?
6. Path containment: does any new path join from external input (ids, names, archive entries, user paths) check with `isPathContained` from `src/adapters/storage/path-containment.ts`? Flag `startsWith` on path strings and hand-rolled containment.
7. Cleanup: do cleanup errors replace the first failure, and are separately awaited cleanup stages distinguished in logs?

Reply `All clear` if nothing applies. Otherwise one line per finding: `file:line — problem — minimal fix`.
