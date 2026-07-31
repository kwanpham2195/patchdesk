# Plan 008: Serialize merge writes and reconcile uncertain outcomes

> **Executor instructions**: Complete Plan 007 first. This is a high-risk
> state-machine change: write tests before each production step and stop when
> the persisted contract is unclear. Update `advisor-plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/domain/merge-operation.ts src/adapters/storage/merge-operation-store.ts src/adapters/github/github-adapter.ts src/services/merge-service.ts src/services/merge-write-controller.ts src/services/review-recovery-service.ts src/main/local-api.ts tests/domain/merge-operation.test.ts tests/storage/merge-operation-store.test.ts tests/services/merge-write-controller.test.ts tests/services/review-recovery-service.test.ts tests/local-api-auth.test.ts tests/adapters/github-adapter.test.ts`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/007-characterize-review-run-merge-apis.md`
- **Category**: bug
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

The merge controller performs load, remote GitHub mutation, and local save
without serialization or a durable intent. Two requests can merge concurrently,
and a crash or local write failure after GitHub succeeds leaves Patchdesk
showing an unmerged session with no safe way to know the outcome. The merge
path needs a per-session lock plus a small durable operation journal that can be
reconciled without repeating the remote mutation.

## Current state

- `src/services/merge-write-controller.ts:19-30` does:

```ts
const session = await this.sessions.load(profileId, sessionId);
const merged = await mergePullRequest({ ... });
if (merged._tag === "err") return merged;
return this.sessions.save(profileId, merged.value);
```

- `src/services/review-write-controller.ts:21-72` is the local exemplar for a
  per-session `inFlight` guard and expected-revision checks.
- `src/services/merge-service.ts:69-89` mutates GitHub before returning a
  locally merged `ReviewSession`.
- `ReviewSession` stores a confirmed `mergeDecision`, but there is no durable
  in-progress or outcome-unknown record.
- A GitHub write still requires explicit user confirmation in the UI. Preserve
  that boundary; reconciliation is read-only.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused | `pnpm test -- --run tests/domain/merge-operation.test.ts tests/storage/merge-operation-store.test.ts tests/services/merge-write-controller.test.ts tests/services/review-recovery-service.test.ts tests/local-api-auth.test.ts tests/adapters/github-adapter.test.ts` | all focused tests pass |
| Static | `pnpm lint && pnpm typecheck` | both exit 0 |
| Unit gate | `pnpm test -- --run` | all tests pass |
| Build | `pnpm build` | exit 0 |

## Suggested executor toolkit

- Use `patchdesk-review-lifecycle` for the state and recovery design.
- Use `tdd` for the controller and journal changes.

## Scope

**In scope**:

- `src/domain/merge-operation.ts` (create)
- `src/adapters/storage/merge-operation-store.ts` (create)
- `src/adapters/github/github-adapter.ts`
- `src/services/merge-service.ts`
- `src/services/merge-write-controller.ts`
- `src/services/review-recovery-service.ts`
- `src/main/local-api.ts`
- `tests/domain/merge-operation.test.ts` (create)
- `tests/storage/merge-operation-store.test.ts` (create)
- `tests/services/merge-write-controller.test.ts`
- `tests/services/review-recovery-service.test.ts`
- `tests/local-api-auth.test.ts`
- `tests/adapters/github-adapter.test.ts`

**Out of scope**:

- Automatic merge without an explicit confirmed UI request.
- Retrying a remote merge when its prior outcome is unknown.
- Merge queue support.
- Review-policy accuracy; Plan 009 owns that.
- Changing Electron security or adding network calls from the renderer.

## Git workflow

- Complete Plan 007 first. Stay on the current branch or use authorized
  `fix/durable-merge-writes`.
- Use small conventional commits, for example:
  `test: define durable merge operation contract` then
  `fix: reconcile uncertain merge outcomes`.
- Stage explicit in-scope paths only. Do not push.

## Steps

### Step 1: Define a minimal durable merge-operation state machine

Create `src/domain/merge-operation.ts` with parsed construction/transitions for:

- `Requested`: profile/session/PR identity, method, expected head SHA,
  acknowledged warning codes, operation ID, started timestamp;
- `OutcomeUnknown`: the remote call began but no confirmed receipt was durably
  recorded;
- `Confirmed`: merged timestamp and optional merge commit SHA;
- `Rejected`: a finite safe failure code from a pre-remote or confirmed remote
  rejection.

Do not persist tokens, raw GitHub bodies, commands, paths, model output, or
free-form error text. Invalid transitions return the repo's `Result` style.

**Verify**:
`pnpm test -- --run tests/domain/merge-operation.test.ts`
→ transitions, invalid transitions, and redaction tests pass.

### Step 2: Persist operations atomically under app-owned storage

Create `MergeOperationStore` using injected `PatchdeskPaths` and clock patterns
from `ReviewSessionStore` and `ReviewPreparationJournal`. Use strict schema
validation and atomic temp-write/rename. Store one current operation per
profile/session in the existing app-owned review data tree.

Expose `begin`, `markOutcomeUnknown`, `confirm`, `reject`, `load`, `listPending`,
and `removeAfterSessionReceipt`. Do not recursively delete caller-provided
paths.

**Verify**:
`pnpm test -- --run tests/storage/merge-operation-store.test.ts`
→ round-trip, corrupt schema, atomic replacement, and pending-list tests pass.

### Step 3: Serialize the controller and order durable writes

In `MergeWriteController`, follow the `ReviewWriteController` in-flight pattern
with a key of profile ID plus session ID. Required order:

1. reject a concurrent request before any remote call;
2. load/reconcile an existing pending operation;
3. validate current session revision, head, method, and acknowledgements;
4. persist `Requested`;
5. mark `OutcomeUnknown` immediately before invoking the GitHub merge writer;
6. on confirmed remote failure, persist `Rejected` and return the mapped error;
7. on success, persist `Confirmed`, save the merged session, then remove the
   operation only after the session receipt is durable.

If any local write fails after step 5, return a new finite
`merge_outcome_unknown` error and retain the journal. Never repeat the merge
inside the same call.

**Verify**:
`pnpm test -- --run tests/services/merge-write-controller.test.ts`
→ concurrency, ordering, pre-remote failure, post-remote failure, and confirmed
success cases pass.

### Step 4: Add read-only GitHub reconciliation

Extend the GitHub adapter contract with a focused merge-outcome read that can
distinguish open, closed-unmerged, and merged, returning merged timestamp and
optional commit SHA. Implement it for production and fake adapters.

When a journal is `OutcomeUnknown` or `Confirmed` without a session receipt:

- if GitHub says merged, apply the confirmed receipt locally without issuing a
  merge write;
- if GitHub says open or closed-unmerged, retain a finite rejected/unknown
  state and require a fresh explicit user request;
- if the read is unavailable or ambiguous, keep `OutcomeUnknown` and block a
  new merge.

**Verify**:
`pnpm test -- --run tests/adapters/github-adapter.test.ts tests/services/merge-write-controller.test.ts`
→ all reconciliation states pass and remote merge call count remains zero.

### Step 5: Reconcile pending operations during startup recovery

Inject the operation store/controller into `ReviewRecoveryService` and local API
composition. Reconcile pending operations after preparation/review recovery but
before accepting merge writes. A reconciliation read failure must produce a
safe diagnostic and leave the operation pending, not fail app startup.

Update HTTP mapping so `merge_outcome_unknown` is a conflict response with a
finite user-facing code; do not include raw adapter text.

**Verify**:
`pnpm test -- --run tests/services/review-recovery-service.test.ts tests/local-api-auth.test.ts`
→ startup and HTTP composition cases pass.

### Step 6: Run repository gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build`
→ all commands exit 0.

## Test plan

- Domain transitions and strict persisted schema.
- Atomic store behavior and corrupt-journal preservation.
- Two simultaneous merge requests produce one GitHub write.
- Crash-equivalent failures before remote, after remote, after confirmation,
  and after session save.
- Startup reconciliation for merged, open, closed-unmerged, and unavailable.
- HTTP reports finite conflict without leaking raw data.

## Done criteria

- [ ] Per-session merge calls are serialized.
- [ ] Durable intent exists before a remote merge can begin.
- [ ] No uncertain outcome triggers an automatic second merge.
- [ ] Startup can reconcile a confirmed GitHub merge into session state.
- [ ] All focused/static/unit/build gates pass.
- [ ] Only in-scope files and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- Plan 007 characterization tests are absent or failing.
- GitHub cannot authoritatively distinguish merged from closed-unmerged with
  the supported authentication/API surface.
- The operation store would require a destructive migration.
- Reconciliation would require an unconfirmed remote write.
- An in-scope verification fails twice.

## Maintenance notes

Reviewers should audit every crash boundary and call-count assertion. Any future
merge method or queue operation must enter the same serialized durable path.
