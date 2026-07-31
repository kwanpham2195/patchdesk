# Plan 004: Skip terminal sessions during orphan recovery

> **Executor instructions**: Follow this plan in order and update the status in
> `advisor-plans/README.md` when complete. Stop on any listed STOP condition.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/services/review-recovery-service.ts tests/services/review-recovery-service.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

Completed review sessions retain their latest attempt ID. Startup recovery
currently treats every such ID as an orphan candidate, then calls a primitive
that only accepts running sessions. That converts valid terminal state into
spurious recovery failures and diagnostics on every launch.

## Current state

- `src/services/review-recovery-service.ts:119-180` loads an attempt whenever
  `currentAttemptId` exists and calls `recoverOrphanedWorkbenchAttempt`.
- `src/services/review-workbench.ts:149-175` accepts only a session in
  `Running` and an attempt in `Starting` or `Running`.
- `src/domain/review-session.ts:325-333` completes a review without clearing
  `currentAttemptId`; that retained reference is intentional history.
- `tests/services/review-recovery-service.test.ts` already has isolated profile,
  session, and diagnostic stores. Match those fixtures.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused | `pnpm test -- --run tests/services/review-recovery-service.test.ts` | all focused tests pass |
| Static | `pnpm lint && pnpm typecheck` | both exit 0 |
| Unit gate | `pnpm test -- --run` | all tests pass |

## Scope

**In scope**:

- `src/services/review-recovery-service.ts`
- `tests/services/review-recovery-service.test.ts`

**Out of scope**:

- Clearing attempt history from completed sessions.
- Changing the workbench recovery primitive.
- Recovering failed, completed, or merged sessions.
- Storage schema changes.

## Git workflow

- Stay on the current branch unless authorized to use
  `fix/skip-terminal-review-recovery`.
- Commit example: `fix: skip terminal review recovery`.
- Stage only the two in-scope files. Do not push.

## Steps

### Step 1: Add terminal-state regression tests

Add fixtures for a `ReviewCompleted` session and a `Merged` session that each
retain `currentAttemptId`. Run recovery and assert:

- neither attempt is sent through orphan recovery;
- neither session is counted as a recovery failure;
- no failure diagnostic is written;
- stored session and attempt state remains unchanged.

Keep or add the positive case showing a `Running` session with a
`Starting`/`Running` attempt is still recovered.

**Verify**:
`pnpm test -- --run tests/services/review-recovery-service.test.ts`
→ new terminal tests fail on current code and the running case passes.

### Step 2: Filter by session lifecycle before loading the attempt

In `ReviewRecoveryService`, continue immediately unless
`session.state._tag === "Running"`. Apply the filter before loading
`currentAttemptId` so terminal attempt history is not mistaken for active work.
Do not clear IDs or mutate terminal sessions.

Let the existing primitive continue validating attempt lifecycle for running
sessions. Preserve its current diagnostic behavior for genuinely inconsistent
running data.

**Verify**:
`pnpm test -- --run tests/services/review-recovery-service.test.ts`
→ all focused tests pass.

### Step 3: Run repository gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run`
→ every command exits 0.

## Test plan

- Completed session with retained attempt: skipped.
- Merged session with retained attempt: skipped.
- Running session with orphaned active attempt: recovered.
- Running session with inconsistent attempt: existing failure reporting remains.

## Done criteria

- [ ] Only `Running` sessions enter orphan-attempt recovery.
- [ ] Terminal state and attempt history are preserved.
- [ ] Terminal sessions emit no false recovery failure.
- [ ] Focused, static, and full unit gates pass.
- [ ] Only in-scope files and the index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- Current domain code no longer retains attempt IDs in terminal states.
- Product requirements say terminal attempts must be actively reconciled.
- The fix requires a persisted schema migration.
- A focused verification fails twice.

## Maintenance notes

If new terminal session tags are added, keep this service allowlist-based:
recover only known active states rather than enumerating states to skip.
