# Plan 006: Test merge orchestration through the real merge service

> **Executor instructions**: This is a test-only change. Do not add a production injection seam merely to replace the module mock. Use the controller's existing GitHub gateway dependency and the real `mergePullRequest` path. Update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat 4db4917..HEAD -- tests/services/merge-write-controller.test.ts src/services/merge-write-controller.ts src/services/merge-service.ts src/services/github-revision-identity-reader.ts src/adapters/github/fake-github-adapter.ts`
> If merge orchestration or gateway contracts changed, remap each scenario before editing tests.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/002-enforce-safe-staged-quality.md`
- **Category**: tests
- **Status**: DONE — real merge-service orchestration, recording gateway, focused tests, complete tests, typecheck, build, and staged quality verified.
- **Planned at**: commit `4db4917`, 2026-08-21

## Why this matters

`merge-write-controller.test.ts` replaces the imported merge service with `vi.mock`. This bypasses the real revision proof, readiness policy, and gateway behavior, while coupling assertions to an imported function call. The controller already receives a GitHub gateway, which is the correct test seam.

## Current state

- `tests/services/merge-write-controller.test.ts:3-5` mocks `../../src/services/merge-service`.
- The test imports and wraps `mergePullRequest` with `vi.mocked` at approximately `:17-29`.
- The fixture passes `{}` as the controller's GitHub gateway because the module mock prevents real service execution.
- `src/services/merge-write-controller.ts:141-148` calls the real `mergePullRequest` with the injected gateway.
- `src/services/merge-service.ts:45-132` proves revision identity, reads merge policy, evaluates readiness, and then writes through `gateway.mergePullRequest`.
- `src/adapters/github/fake-github-adapter.ts` provides a production-owned fixture adapter, but it does not record write calls. A small test-local recording subclass/wrapper is appropriate.
- `tests/services/merge-service.test.ts` covers a focused unavailable-proof case and must remain separate.

## Commands you will need

| Purpose          | Command                                                                                                        | Expected on success                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Controller tests | `pnpm test -- --run tests/services/merge-write-controller.test.ts`                                             | all orchestration cases pass through real service |
| Merge tests      | `pnpm test -- --run tests/services/merge-service.test.ts tests/services/merge-write-controller-reason.test.ts` | all pass                                          |
| Mock check       | `rg -n -e "vi\.mock" -e "vi\.mocked" -e "mockedMerge" tests/services/merge-write-controller.test.ts`           | no matches                                        |
| Typecheck        | `pnpm typecheck`                                                                                               | exit 0                                            |
| Staged quality   | `pnpm lint:staged`                                                                                             | touched test file passes                          |

## Scope

**In scope**:

- `tests/services/merge-write-controller.test.ts`

**Out of scope**:

- All production files.
- Changing merge policy, error mapping, persistence order, or gateway contracts.
- Consolidating `merge-service.test.ts` into the controller suite.
- Introducing an injectable function solely for `mergePullRequest`.
- Network or process-backed GitHub behavior.

## Git workflow

- Branch: `test/merge-controller-real-service`
- Commit: `test(merge): exercise real service from controller`
- Keep source files unchanged.

## Steps

### Step 1: Remove the module patch and build valid fixtures

Delete the top-level `vi.mock`, the imported mocked function handle, and assertions against `mockedMerge`.

Replace cast-heavy fixture values with parser-built IDs, SHAs, timestamps, and content hashes. Build a complete `ReviewSession`, profile, Review, and snapshot that satisfy the same fresh-write gate contract used in production.

The session must include:

- matching head and base SHA;
- one canonical patch hash or a valid legacy no-hash state;
- PR identity and open state;
- enough worktree/patch fields to satisfy the domain type without unsafe casts.

Because the touched-file ratchet applies, remove all unjustified `as never`, chained assertions, and fake safety comments from this file.

**Verify**: `pnpm typecheck` → fixture compiles against real contracts.

### Step 2: Add a recording GitHub gateway

Create a test-local recording gateway, preferably by wrapping or extending `FakeGitHubAdapter`, that:

- returns a current PR summary with matching head/base and `changedFileCount: 1`;
- returns a complete one-file canonical diff beginning with one `diff --git` line;
- returns configurable merge policy evidence;
- returns configurable merge write success/failure;
- records merge requests in an array.

The fake must implement the injected gateway seam. Do not spy on `mergePullRequest` internals and do not patch modules.

Use valid policy defaults representing an open, non-draft, mergeable PR with passing checks, no review blocker, and the expected head/base pair.

**Verify**: add one direct fixture assertion through the controller showing the recording gateway receives exactly one merge request on a successful path.

### Step 3: Re-express every existing scenario through real gateway evidence

Map the existing tests as follows:

- malformed input: no write-gate or gateway call;
- mismatched acknowledgement: rejected before persistence;
- stale represented revision: rejected before the real service;
- outcome unknown: configure gateway merge failure category `unavailable`; durable operation remains unknown;
- finite rejection: configure readiness/policy to produce a real blocked result or configure a finite GitHub rejection, according to the assertion's intended layer;
- successful merge: complete proof and policy, then gateway success with merge commit SHA;
- Review save failure: gateway merge succeeds, operation confirms, terminal Review save fails, evidence is retained;
- concurrent merge: coordinator blocks before gateway work.

Preserve assertions about durable operation transitions and Review-save-before-receipt-removal ordering. Replace imported-function assertions with recording gateway calls and durable effects.

**Verify after each scenario group**: focused controller test passes.

### Step 4: Preserve failure-reason coverage

Run `tests/services/merge-write-controller-reason.test.ts` and `tests/services/merge-service.test.ts`. Do not duplicate their mapping matrix in the controller orchestration file. If the real service exposes an untested mapping needed by a migrated case, add it to the existing reason test rather than creating another module mock.

**Verify**: all three focused files pass together.

### Step 5: Run final gates

```bash
rg -n "vi\.mock|vi\.mocked|mockedMerge" tests/services/merge-write-controller.test.ts
pnpm exec oxfmt --check tests/services/merge-write-controller.test.ts
pnpm exec oxlint --deny-warnings tests/services/merge-write-controller.test.ts
pnpm typecheck
pnpm test -- --run tests/services/merge-write-controller.test.ts tests/services/merge-write-controller-reason.test.ts tests/services/merge-service.test.ts
pnpm test:all
```

Expected: grep has no output; all other commands exit 0.

## Test plan

Keep the controller suite focused on orchestration and durable side effects. The real merge service introduces revision and readiness behavior; configure those through the recording gateway rather than asserting its private sequence. Preserve separate service-level reason/readiness tests.

## Done criteria

- [x] No module mock or mocked imported function remains.
- [x] Every controller test runs the real `mergePullRequest` path when it reaches merge execution.
- [x] A recording injected gateway proves whether a write occurred.
- [x] Existing durable-operation and save-order assertions remain.
- [x] The touched test file has no unsafe fixture casts or lint findings.
- [x] Focused tests, typecheck, complete tests, and staged quality pass.
- [x] No production behavior changed; the prior test-only seam is restored to the existing controller dependency.
- [x] `advisor-plans/README.md` is updated.

## STOP conditions

- Real-service execution requires a production code seam change.
- A test would need network, filesystem, or process execution.
- The recording gateway cannot express a valid revision/readiness state through public contracts.
- Migrating a case changes the production behavior it is asserting rather than only the test seam.

## Maintenance notes

Use injected adapters and recording fakes for effects. Do not reintroduce module patches when merge orchestration changes. Reviewers should verify that blocked/stale paths prove the GitHub merge method was not called and uncertain outcomes retain durable evidence.
