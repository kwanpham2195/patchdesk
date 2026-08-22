# Plan 005: Stop retention scheduling with the Local API server

> **Executor instructions**: Preserve best-effort cleanup semantics while making lifecycle ownership explicit. Use fake timers and deferred promises; never wait 24 hours in a test. Update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat 4db4917..HEAD -- src/main/local-api.ts src/main/electron-main.ts src/services/storage-management-service.ts tests/main-lifecycle.test.ts tests/services/storage-management-service.test.ts`
> Changes to `LocalApiServer.stop`, scheduler startup, or sweep semantics require reconciliation before implementation.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `advisor-plans/001-run-complete-test-gate.md`
- **Category**: bug
- **Status**: DONE — scheduler lifecycle, focused tests, complete tests, typecheck, build, and staged quality verified.
- **Planned at**: commit `4db4917`, 2026-08-21

## Why this matters

`startLocalApiServer` starts an immediate retention sweep and an unref'd daily interval, but `LocalApiServer.stop()` closes only the HTTP server. The timer and an active sweep can outlive their owner during shutdown or same-process restart. Lifecycle-owned work must stop when its server stops.

## Current state

- `src/main/local-api.ts:1294-1302` calls `scheduleRetentionSweeps` and discards its result.
- `LocalApiServer.stop` at approximately `:1309-1311` only awaits `closeServer(server)`.
- `scheduleRetentionSweeps` at `:1324-1351` returns `void`, launches sweep promises fire-and-forget, and keeps only a local interval handle.
- The interval is unref'd, so it does not hold process exit, but that does not cancel it.
- `src/main/electron-main.ts:189-191` delegates shutdown to `server.stop()`.
- `tests/services/storage-management-service.test.ts:450-530` already covers sweep item behavior and diagnostics. Do not duplicate those service tests.

Target design: a small scheduler owner with one idempotent asynchronous `stop()` method. It clears future ticks and settles any sweep already started.

## Commands you will need

| Purpose         | Command                                                           | Expected on success           |
| --------------- | ----------------------------------------------------------------- | ----------------------------- |
| Scheduler tests | `pnpm test -- --run tests/main/retention-sweep-scheduler.test.ts` | lifecycle cases pass          |
| Lifecycle tests | `pnpm test -- --run tests/main-lifecycle.test.ts`                 | existing stop ordering passes |
| Typecheck       | `pnpm typecheck`                                                  | exit 0                        |
| Complete tests  | `pnpm test:all`                                                   | all suites pass               |
| Build           | `pnpm build`                                                      | exit 0                        |

## Scope

**In scope**:

- `src/main/retention-sweep-scheduler.ts` (new)
- `src/main/local-api.ts`
- `tests/main/retention-sweep-scheduler.test.ts` (new)
- `tests/local-api-auth.test.ts` only if a server-level stop assertion is needed

**Out of scope**:

- Retention eligibility or deletion behavior in `StorageManagementService`.
- Retention interval duration.
- New API routes or renderer behavior.
- AbortSignal plumbing through storage operations.
- General `local-api.ts` decomposition.

## Git workflow

- Branch: `fix/retention-scheduler-stop`
- Commit: `fix(main): stop retention scheduler with local api`
- Do not alter unrelated Local API routes.

## Steps

### Step 1: Extract an owned scheduler

Create `src/main/retention-sweep-scheduler.ts` with a narrow API similar to:

```ts
export type RetentionSweepScheduler = {
  stop(): Promise<void>;
};

export function startRetentionSweepScheduler(input: {
  profiles: ReadonlyArray<{ readonly id: WorkspaceProfileId }>;
  storageManagement: Pick<StorageManagementService, "sweepRetained">;
  enabled: boolean;
  diagnostics?: Pick<ReviewDiagnosticService, "record">;
}): RetentionSweepScheduler;
```

The implementation must:

- return an idempotent no-op owner when disabled;
- run once immediately when enabled;
- schedule the existing 24-hour interval and call `unref()`;
- prevent overlapping interval sweeps;
- catch every per-profile sweep failure and preserve the current retryable diagnostic behavior;
- catch diagnostic failure as best effort;
- track the complete active run, including diagnostic promises.

Use the existing `RETENTION_SWEEP_INTERVAL_MS` constant, moved to the scheduler module if that makes ownership clearer.

**Verify**: typecheck passes with the new module before Local API wiring changes.

### Step 2: Define idempotent stop semantics

`stop()` must:

1. mark the owner stopped before awaiting anything;
2. clear the interval exactly once;
3. prevent any future immediate/interval callback from starting work;
4. await the currently active sweep, if any;
5. resolve rather than reject after already-contained sweep/diagnostic failures;
6. return the same completion behavior on repeated calls.

Do not add a timeout without a separate product decision. Current sweeps are local storage operations; silently abandoning an active operation would not satisfy lifecycle ownership.

**Verify**: fake-timer/deferred tests prove stop waits for one active promise and a second stop is harmless.

### Step 3: Wire the owner into Local API lifecycle

In `startLocalApiServer`:

- retain the scheduler returned by `startRetentionSweepScheduler`;
- in `server.stop()`, stop the scheduler before or as part of HTTP closure;
- ensure HTTP closure still runs if scheduler cleanup is best-effort; the scheduler's stop should normally never reject;
- keep the externally visible `LocalApiServer` interface unchanged.

Recommended order:

```ts
await retentionScheduler.stop();
await closeServer(server);
```

This stops new background storage work before the server owner is gone.

**Verify**: existing `tests/main-lifecycle.test.ts` passes; add a server-level assertion only if module-level tests cannot prove Local API calls scheduler stop.

### Step 4: Add scheduler lifecycle tests

Create `tests/main/retention-sweep-scheduler.test.ts` using `vi.useFakeTimers()` and deferred promises. Cover:

1. disabled owner starts no sweep and stop is safe;
2. enabled owner runs immediately;
3. one interval tick starts one subsequent sweep;
4. timer handle is unref'd where the injected/real handle supports it;
5. interval ticks do not overlap an active sweep;
6. stop clears future ticks;
7. stop waits for an active sweep;
8. repeated stop calls are idempotent;
9. per-profile failure records the existing retryable diagnostic;
10. rejected sweep and diagnostic promises do not escape as unhandled rejection.

Always restore real timers in cleanup.

**Verify**: focused scheduler tests pass with no open-handle warning.

### Step 5: Run final gates

```bash
pnpm typecheck
pnpm test -- --run tests/main/retention-sweep-scheduler.test.ts tests/main-lifecycle.test.ts tests/services/storage-management-service.test.ts
pnpm test:all
pnpm build
```

Expected: all exit 0 and Vitest reports no leaked timers or unhandled promises.

## Test plan

Test scheduler lifecycle, not storage retention rules. Use `tests/renderer/inbox-refresh-scheduler.test.ts` as a fake-timer style reference and `tests/services/storage-management-service.test.ts` as the existing sweep behavior authority.

## Done criteria

- [x] The scheduler has one explicit owner returned from startup.
- [x] Local API stop clears the interval and settles active work.
- [x] No overlapping sweep starts.
- [x] Stop is idempotent and does not leak timer handles.
- [x] Existing diagnostic behavior remains.
- [x] Focused tests, typecheck, complete tests, build, and staged quality pass.
- [x] No retention eligibility/deletion behavior changed.
- [x] `advisor-plans/README.md` is updated.

## STOP conditions

- `sweepRetained` can legitimately remain pending indefinitely; an explicit bounded-shutdown design is then required.
- Correct shutdown requires changing the public Local API interface or Electron lifecycle contract.
- Tests reveal an existing intentional overlap requirement.
- A fix expands into retention-policy or cleanup-selection changes.

## Maintenance notes

Every interval, watcher, or fire-and-forget task started by Local API must return an owner that participates in `stop()`. Review future additions for the same pattern. Keep per-item retention behavior in `StorageManagementService`; the main module owns only scheduling and lifecycle.
