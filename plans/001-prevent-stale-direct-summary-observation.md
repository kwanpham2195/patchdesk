# Plan 001: Prevent stale direct-summary observation from replacing Refresh

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Preserve all existing direct-summary receipt behavior. If a STOP
> condition occurs, stop and report; do not improvise. When done, update this
> plan's row in `plans/README.md` unless a reviewer maintains the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 7b4f6e6..HEAD -- \
>   src/renderer/src/flows/review-workbench-flow.tsx \
>   tests/renderer/review-workbench-flow.ui.test.tsx
> git diff --stat -- \
>   src/renderer/src/flows/review-workbench-flow.tsx \
>   tests/renderer/review-workbench-flow.ui.test.tsx
> git diff --cached --stat -- \
>   src/renderer/src/flows/review-workbench-flow.tsx \
>   tests/renderer/review-workbench-flow.ui.test.tsx
> ```
>
> Both files were already modified when this plan was written. This plan fixes
> one defect inside that uncommitted feature. Read the complete dirty diff before
> editing. If the direct-summary flow no longer matches **Current state**, STOP.

## Status

- **Priority**: P1 — execute first; highest leverage in this portfolio
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none; it completes the current uncommitted direct-summary work
- **Category**: bug / concurrency
- **Planned at**: commit `7b4f6e6`, 2026-08-13

## Why this matters

A confirmed direct review starts a read-only metadata observation after its
receipt is shown. That response can arrive after an explicit Refresh has loaded
a newer Review session. The current callback then replaces or patches the newer
projection with stale observation data. This can regress freshness, metadata,
Conversation, checks, or terminal status even though Refresh is the sole
changed-revision adoption path.

The normal detector already solves the same race with a generation and snapshot
key. Apply that protocol to confirmed direct-summary observation and add a
regression that makes Refresh finish first.

## Current state

`src/renderer/src/flows/review-workbench-flow.tsx:294-310` captures both guards
before normal detection and checks them after its request:

```ts
const generation = generationRef.current;
const key = snapshotKey(wb);
const value = await requestJson(...);
const current = workbenchRef.current;
if (generationRef.current !== generation || snapshotKey(current) !== key)
  return;
```

`observeConfirmedDirectSummary()` at approximately lines 472-513 only
increments the generation. After awaiting `/v1/reviews/detect-updates`, it uses
the pre-request `current` projection and can call `replaceWorkbench(next)` or
`onWorkbenchPatchRef.current(...)` without proving ownership:

```ts
const current = workbenchRef.current;
generationRef.current += 1;
const value = await runDirectCommand(...);
const observation = isReviewObservation(value);
// No post-await generation or snapshot check.
```

`requestRefresh()` increments the same generation before its network request.
`snapshotKey()` includes Review ID, session ID, reviewed head SHA, and
`refreshedAt`. These are the existing ownership primitives; do not create a
second race protocol.

Use the deferred normal-detector test near
`tests/renderer/review-workbench-flow.ui.test.tsx:2140` as the timing pattern.
Extend the confirmed direct-summary test near line 2819 rather than replacing
its exact receipt assertion.

## Commands you will need

- Focused test:
  `pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Build: `pnpm build`
- Whitespace: `git diff --check`

Expected on success: every command exits 0; tests report no new skip.

## Scope

**In scope**

- `src/renderer/src/flows/review-workbench-flow.tsx`
- `tests/renderer/review-workbench-flow.ui.test.tsx`
- `plans/README.md` status only

**Out of scope**

- Server observation or Refresh semantics
- Receipt persistence, recovery, or direct-summary submission
- Normal detector scheduling
- Any UI redesign
- Any change that delays rendering a confirmed receipt until observation ends

## Git workflow

- Stay on the current branch unless the operator requests otherwise.
- Preserve all pre-existing hunks in both in-scope files.
- Stage explicit files only. Do not push or commit unless asked.
- If asked to commit, use `fix: prevent stale direct-summary observation`.

## Steps

### Step 1: Add the Refresh-wins regression

Extend the confirmed direct-summary test setup so the request containing
`recentWrites: [{ _tag: "DirectSummaryReview", ... }]` returns a deferred
promise. Keep the initial advisory detector separate.

The test sequence must be:

1. Submit the direct review and confirm its receipt UI can render without
   waiting for observation.
2. Leave the receipt-driven observation pending.
3. Open PR overview and run **Refresh GitHub state**.
4. Resolve Refresh with a replacement projection whose session or
   `refreshedAt` differs from the original.
5. Confirm `onWorkbenchReplace` receives the refreshed projection.
6. Resolve the older receipt-driven observation with either a reconciled old
   projection or a stale patch result.
7. Confirm it does not replace or patch the refreshed projection.

Keep the existing assertion that the observation request carries the exact
confirmed GitHub review ID.

**Verify**:

```bash
pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx \
  -t "ignores direct-summary observation that loses ownership to Refresh"
```

Expected before the fix: the new assertion fails because the old observation
writes after Refresh. Expected after Step 2: it passes.

### Step 2: Give direct-summary observation the existing ownership guard

In `observeConfirmedDirectSummary()`:

1. Read the current projection.
2. Increment the observation generation, then capture that exact generation.
3. Capture `snapshotKey(current)` before the request.
4. After the request resolves, read `workbenchRef.current` again.
5. Return without any replace or patch when the generation changed or the
   current snapshot key differs.
6. Validate reconciled identity against the post-await current projection, not
   the stale closure.
7. Build RevisionChanged, Unavailable, and Terminal patches from the post-await
   current projection.

Do not decrement the generation and do not make observation block Refresh.
Receipt rendering remains independent of this background read.

**Verify**:

```bash
pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx
```

Expected: the full file passes, including the existing normal-detector race,
publication-refresh race, durable receipt, and write-another-review cases.

### Step 3: Run the focused quality gate

```bash
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands exit 0 and `git diff --check` prints nothing.

## Test plan

Required cases in `tests/renderer/review-workbench-flow.ui.test.tsx`:

- Confirmed receipt is visible before observation completes.
- Observation request includes the exact direct-summary GitHub review ID.
- Reconciled observation still updates the same owned projection.
- Explicit Refresh that finishes first wins permanently.
- A stale RevisionChanged/Unavailable/Terminal result also cannot patch the new
  projection.

Use deferred promises, not real timers or arbitrary sleeps, for response order.

## Done criteria

- [ ] The callback captures and rechecks generation plus `snapshotKey()`.
- [ ] No post-await branch uses the pre-request projection as write authority.
- [ ] A deferred receipt observation cannot replace or patch a newer Refresh.
- [ ] Confirmed receipts still render without waiting for observation.
- [ ] The focused renderer test file passes.
- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass.
- [ ] `git diff --check` has no output.
- [ ] No file outside Scope changed for this plan.
- [ ] `plans/README.md` marks Plan 001 DONE.

## STOP conditions

Stop and report if:

- The current direct-summary dirty work was removed or changed into a different
  protocol.
- Refresh no longer increments the shared generation or no longer replaces the
  represented projection.
- Correctness would require delaying the confirmed receipt until observation.
- The fix would change server adoption, retry, or write behavior.
- A verification fails twice after one focused correction.

## Maintenance notes

Every asynchronous read that can replace or patch the workbench must prove that
it still owns the same generation and represented snapshot after awaiting. The
shared generation and `snapshotKey()` are the one renderer protocol for this;
do not add callback-specific booleans.
