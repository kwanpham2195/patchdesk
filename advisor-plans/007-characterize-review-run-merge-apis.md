# Plan 007: Characterize authenticated review run and merge APIs

> **Executor instructions**: This plan adds tests only. Do not change
> production code to make an assertion pass; stop if a missing injection seam
> makes characterization impossible. Update `advisor-plans/README.md` when
> complete.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- tests/services/review-execution-service.test.ts tests/services/merge-write-controller.test.ts tests/local-api-auth.test.ts src/main/local-api.ts src/services/review-execution-service.ts src/services/merge-write-controller.ts`
> Production paths are read-only references in this plan.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

The authenticated `/v1/reviews/run` and `/v1/reviews/merge` composition paths
lack direct coverage, even though they coordinate persisted session state,
model availability, head verification, GitHub writes, and error mapping. These
tests are the safety net for the following merge durability and policy plans.

## Current state

- `src/main/local-api.ts:489-511` starts a review, maps domain errors, starts
  the coordinator, and returns HTTP 202.
- `src/main/local-api.ts:578-582` delegates merge requests to
  `MergeWriteController`.
- `src/services/review-execution-service.ts:44-140` loads the session/catalog,
  verifies head state, begins the attempt, and creates run artifacts.
- `src/services/merge-write-controller.ts:19-30` loads the session, calls the
  merge service, then saves.
- `tests/local-api-auth.test.ts` covers older review workflow and review write
  routes, but not authenticated success for these two endpoints.
- `tests/services/review-run-coordinator.test.ts` is the local pattern for
  service fakes and lifecycle assertions.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused | `pnpm test -- --run tests/services/review-execution-service.test.ts tests/services/merge-write-controller.test.ts tests/local-api-auth.test.ts` | all focused tests pass |
| Static | `pnpm lint && pnpm typecheck` | both exit 0 |
| Unit gate | `pnpm test -- --run` | all tests pass |

## Scope

**In scope**:

- `tests/services/review-execution-service.test.ts` (create)
- `tests/services/merge-write-controller.test.ts` (create)
- `tests/local-api-auth.test.ts`

**Read-only references**:

- `src/main/local-api.ts`
- `src/services/review-execution-service.ts`
- `src/services/merge-write-controller.ts`
- `tests/services/review-run-coordinator.test.ts`

**Out of scope**:

- Production behavior changes.
- Real GitHub or model calls.
- Live browser/Electron testing.
- Snapshot tests of complete JSON objects when focused field assertions suffice.

## Git workflow

- Stay on the current branch or use authorized
  `test/review-run-merge-api`.
- Commit example: `test: cover review run and merge APIs`.
- Stage only the three test paths. Do not push.

## Steps

### Step 1: Characterize `ReviewExecutionService`

Create a service test using injected stores, clock, catalog, head verifier, and
artifact writer. Cover:

- successful start persists a new attempt and returns runnable artifacts;
- unsupported model and unavailable catalog return their existing tagged
  errors without mutation;
- stale head persists the current remote head outcome and does not start;
- a non-runnable or concurrent session is rejected without a second attempt.

Use domain parsers and existing test builders; do not cast branded IDs.

**Verify**:
`pnpm test -- --run tests/services/review-execution-service.test.ts`
→ all new tests pass.

### Step 2: Characterize `MergeWriteController`

Create a controller test with fake session store and merge service. Cover:

- valid request loads, delegates once, and saves returned session;
- invalid input returns the existing validation error;
- warning acknowledgement is forwarded unchanged;
- merge failure performs no save;
- storage failure after a successful domain result maps to the current
  controller failure behavior.

The final case intentionally records today's uncertainty; Plan 008 changes it.

**Verify**:
`pnpm test -- --run tests/services/merge-write-controller.test.ts`
→ all new tests pass.

### Step 3: Cover authenticated HTTP composition

Extend `tests/local-api-auth.test.ts` using its existing capability/origin
helpers and `LocalApiConfiguration` fakes. Add:

- authenticated `/v1/reviews/run` success returns 202 and starts the
  coordinator exactly once;
- invalid body, unavailable catalog, stale head, and non-runnable session map
  to the current 400/404/409/503 statuses;
- authenticated `/v1/reviews/merge` success delegates once and returns its
  current response;
- malformed merge input and merge-domain failures map to their current status;
- missing/wrong capability and wrong origin remain rejected for both routes.

Do not duplicate every auth matrix if a shared parameterized test can express
it clearly.

**Verify**:
`pnpm test -- --run tests/local-api-auth.test.ts`
→ all local API auth tests pass.

### Step 4: Run static and unit gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run`
→ every command exits 0.

## Test plan

- Service success, mutation boundaries, tagged failures, and stale head.
- Controller delegation/save order and post-remote storage failure.
- HTTP authentication, origin, parsing, success, and status mapping.
- All I/O remains fake and deterministic.

## Done criteria

- [ ] Both service test files exist and cover the named cases.
- [ ] Both authenticated endpoints have success and failure composition tests.
- [ ] No production source file changes.
- [ ] Focused, static, and full unit gates pass.
- [ ] Only in-scope test files and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- `LocalApiConfiguration` cannot inject the relevant collaborators.
- Characterization needs a real GitHub/model/network call.
- Existing behavior is internally contradictory and cannot be asserted without
  selecting new product semantics.
- A focused verification fails twice.

## Maintenance notes

Plans 008 and 009 should update these tests before changing production code.
Keep the HTTP tests focused on composition and status mapping; detailed domain
matrices belong in service tests.
