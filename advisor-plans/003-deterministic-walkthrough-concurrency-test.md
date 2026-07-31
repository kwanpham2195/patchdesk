# Plan 003: Make walkthrough concurrency coverage deterministic

> **Executor instructions**: Follow all steps. This is a test-only plan unless
> the deterministic test exposes a production defect; that case is a STOP.
> Update `advisor-plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- tests/services/narrative-walkthrough-service.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

The full unit suite has timed out in the walkthrough concurrency test while the
same file passes alone. The test uses a zero-delay timer as a scheduling
assumption, so the second request can race ahead before the first reaches its
controlled model invocation. An explicit latch will test the intended
single-flight behavior without depending on event-loop timing.

## Current state

- `tests/services/narrative-walkthrough-service.test.ts:334-410` starts the
  first generation, waits one timer tick, and then starts the second:

```ts
const first = service.generate(request);
await new Promise((resolve) => setTimeout(resolve, 0));
const second = await service.generate(request);
```

- The fake invocation assigns `releaseFirst` only after asynchronous setup has
  already occurred.
- Audit baseline: the full suite passed 533 of 534 tests with this test timing
  out; the focused file then passed 13 of 13.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused | `pnpm test -- --run tests/services/narrative-walkthrough-service.test.ts` | 13 or more tests pass |
| Stress | `for i in {1..20}; do pnpm test -- --run tests/services/narrative-walkthrough-service.test.ts || exit 1; done` | 20 clean runs |
| Unit gate | `pnpm test -- --run` | all tests pass |
| Static gate | `pnpm lint && pnpm typecheck` | both exit 0 |

## Scope

**In scope**:

- `tests/services/narrative-walkthrough-service.test.ts`

**Out of scope**:

- Production walkthrough behavior.
- Increasing test timeouts.
- Adding sleeps, retries, or fake global timers.

## Git workflow

- Stay on the current branch unless authorized to use
  `test/walkthrough-concurrency`.
- Commit example:
  `test: synchronize walkthrough concurrency coverage`.
- Stage only the test file. Do not push.

## Steps

### Step 1: Replace the timer with an invocation-entry latch

Create a promise before the fake model client is built and capture its resolver,
for example `firstInvocationEntered`. Resolve it inside the first `invoke`
implementation immediately before that invocation waits for `releaseFirst`.
After calling `service.generate`, await `firstInvocationEntered` before making
the second request.

Keep the existing assertions that the second request is rejected/serialized
as intended and that releasing the first request lets it complete.

**Verify**:
`pnpm test -- --run tests/services/narrative-walkthrough-service.test.ts`
→ all focused tests pass.

### Step 2: Prove the test no longer depends on scheduling luck

Run the focused test file 20 consecutive times. Do not add retries inside the
test command or increase timeouts.

**Verify**:
`for i in {1..20}; do pnpm test -- --run tests/services/narrative-walkthrough-service.test.ts || exit 1; done`
→ 20 consecutive exit-0 runs.

### Step 3: Run static and full unit verification

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run`
→ all commands exit 0 and no walkthrough test times out.

## Test plan

- Preserve all existing 13 focused cases.
- Change only synchronization in the concurrent-generation case.
- Stress the complete file, then run the full unit suite.

## Done criteria

- [ ] No `setTimeout(resolve, 0)` remains in the concurrency test.
- [ ] The test waits for an explicit first-invocation signal.
- [ ] Twenty focused runs and the full unit gate pass.
- [ ] Only the in-scope test and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- The explicit latch reveals duplicate production invocations.
- The fix requires changing `NarrativeWalkthroughService`.
- The full suite fails for a new non-flaky product defect.
- A verification fails twice after checking the latch.

## Maintenance notes

Keep concurrency tests synchronized on observable fake boundaries. Do not
replace this latch with timer delays during future refactors.
