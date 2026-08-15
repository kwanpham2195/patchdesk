# Plan 010: Characterize React lifecycle and interaction regressions before refactoring

> **Executor instructions**: Follow every step and run each verification command. This plan adds tests only. Do not change production code to make a test easier. If a required seam does not exist, stop and report the missing seam instead of adding test-only production APIs. Update only this plan's status row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat a3813b8..HEAD -- src/renderer/src/flows/review-workbench-flow.tsx src/renderer/src/hooks src/renderer/src/components/conversation.tsx src/renderer/src/components/pull-request-description.tsx tests/renderer tests/browser`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plan 009
- **Category**: tests
- **Planned at**: commit `a3813b8`, 2026-08-14

## Why this matters

Patchdesk has a strong broad baseline—603 Vitest tests, 35 Playwright tests, build checks, and live Electron QA—but the React Doctor cleanup touches async ownership that those broad tests do not fully characterize. Refresh detection, diff hydration, and Insight polling reject stale work by token, generation, and cancellation rules. Refactoring refs or effect dependencies without direct race tests can silently apply stale Review data even while the full suite remains green. This plan supplies those missing proofs before Plans 011 and 012 change production code.

## Current state

- `tests/renderer/use-commit-diff.test.ts` is the best existing pattern: it uses deferred promises and `renderHook` to prove late responses cannot replace a newer selection.
- `tests/renderer/review-workbench-flow.ui.test.tsx` proves a delayed direct-summary observation cannot replace a newer explicit Refresh, but it does not cover overlapping scheduled detection, snapshot generations, or unmount cleanup.
- `src/renderer/src/flows/review-workbench-flow.tsx:230-401` mirrors current values into refs and owns interval/focus/visibility detection scheduling.
- `src/renderer/src/hooks/use-review-diff-hydration.ts:45-201` owns request deduplication and generation checks. There is no focused hook test for replacement or unmount during hydration.
- `src/renderer/src/hooks/use-progressive-review-diff-stream.ts:35-118` rejects completion from old stream generations. There is no focused test for a late old batch.
- `src/renderer/src/hooks/use-insight-run.ts:45-190` owns start, cancellation, polling, terminal reload, and latest callback delivery. There is no focused hook test.
- `src/renderer/src/components/logs-panel.tsx:85-135` mirrors pause and cursor state into refs for polling. Existing tests cover normal cursor progression, not pause changes before a poll, late completion, or unmount cleanup.
- `tests/browser/accessibility.spec.ts` has serious/critical Axe checks and broad keyboard checks. It does not prove the specific Mermaid-source interaction that Plan 012 will restructure.
- `tests/browser/performance.spec.ts` proves a 1,000-file, approximately 10 MB patch remains responsive. Do not weaken its thresholds.

## Commands you will need

- Focused tests: `pnpm test -- --run <test files>` -> all pass.
- Full tests: `pnpm test -- --run` -> all pass.
- Browser accessibility: `pnpm build && pnpm exec playwright test tests/browser/accessibility.spec.ts` -> all pass.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check` -> exit 0.

## Scope

**In scope**:

- `tests/renderer/review-workbench-flow.ui.test.tsx`
- `tests/renderer/use-commit-diff.test.ts`
- `tests/renderer/use-review-diff-hydration.test.ts` (create)
- `tests/renderer/use-progressive-review-diff-stream.test.ts` (create)
- `tests/renderer/use-insight-run.test.ts` (create)
- `tests/renderer/logs-panel.ui.test.tsx`
- `tests/renderer/pull-request-description.ui.test.tsx`
- `tests/browser/accessibility.spec.ts`
- A test-local helper under `tests/renderer/` only if at least three tests reuse it
- `plans/README.md` status row only

**Out of scope**:

- Every production file.
- Snapshot tests of implementation details.
- Assertions on React keys or stateless DOM-node identity.
- Weakening timing, accessibility, or full-suite thresholds.
- Live GitHub writes.

## Git workflow

- Branch: `test/react-doctor-characterization`
- Commit: `test: characterize react lifecycle ownership`
- Stage explicit files only. Do not push unless instructed.

## Steps

### Step 1: Characterize scheduled Review detection

Extend `review-workbench-flow.ui.test.tsx` through the existing bridge seam. Add deterministic tests with deferred responses and fake timers for:

1. A detector response started for snapshot A resolves after projection B is installed; it must not call `onWorkbenchPatch` or `onWorkbenchReplace` for B.
2. Repeated focus/visibility events while one detector request is active do not start a duplicate request.
3. The latest committed `onWorkbenchPatch` callback receives a valid same-generation response after rerender.
4. Unmount clears interval/focus timers and a late response has no visible effect.

Assert caller-visible bridge requests and callbacks, not private ref values.

**Verify**: `pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx` passes with the new cases.

### Step 2: Extend commit-diff callback freshness coverage

In `use-commit-diff.test.ts`, rerender with a new `loadCommitDiff` function before selecting a second SHA. Prove the second selection calls the latest loader exactly once and the first deferred result remains ignored. Keep the existing revision-change test.

**Verify**: `pnpm test -- --run tests/renderer/use-commit-diff.test.ts` passes.

### Step 3: Add diff hydration generation and cancellation tests

Create `use-review-diff-hydration.test.ts` using `renderHook`, deferred desktop-bridge responses, and valid minimal patch fixtures. Cover:

- duplicate path requests share one in-flight request;
- changing patch/session before an old response resolves prevents the old file from entering `hydratedFiles`;
- selected-path status follows only the current path;
- a failed path is not retried in the same generation but can retry after a generation change.

Create `use-progressive-review-diff-stream.test.ts` and cover:

- one append request per visible batch;
- a late batch from generation A does not append into generation B;
- the concurrency and batch constants remain behaviorally bounded without asserting internal ref values.

**Verify**: both new files pass together.

### Step 4: Add Insight polling ownership tests

Create `use-insight-run.test.ts` through the existing desktop bridge. Use fake timers and deferred responses to prove:

- one accepted run owns polling;
- unmount or Review identity change suppresses a late poll and terminal reload;
- terminal completion calls the latest committed patch/replace callback once;
- an old run cannot overwrite a newer active run;
- cancellation errors remain visible but do not fabricate completion.

Do not call a real provider or network.

**Verify**: `pnpm test -- --run tests/renderer/use-insight-run.test.ts` passes.

### Step 5: Characterize log polling ownership

Extend `logs-panel.ui.test.tsx` through its existing bridge seam. Use fake timers and deferred responses to prove:

- pausing before the next poll prevents a new request;
- a request already in flight may commit once under the current behavior, and no later poll starts while paused;
- resuming continues from the cursor committed by that in-flight response exactly once;
- unmount clears the polling timer and suppresses late completion.

Assert bridge requests and visible log rows, not private refs.

**Verify**: `pnpm test -- --run tests/renderer/logs-panel.ui.test.tsx` passes.

### Step 6: Characterize Mermaid interaction accessibility

Extend `pull-request-description.ui.test.tsx` and `accessibility.spec.ts` to prove:

- Mermaid source disclosure is independently keyboard operable;
- activating the source disclosure does not open the image lightbox;
- activating the diagram image does open it;
- no serious or critical Axe violations appear after the interaction.

These tests should fail against any implementation that nests `<summary>` inside a diagram-opening button.

**Verify**: focused renderer tests and `pnpm build && pnpm exec playwright test tests/browser/accessibility.spec.ts` pass.

### Step 7: Run full gates

Run in repository order:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test -- --run`
5. `pnpm build`
6. `pnpm exec playwright test`
7. `git diff --check`

## Test plan

This plan is the test plan. Every new test must fail when its named stale-result, duplicate-request, polling, or interaction invariant is removed. For LogsPanel, characterize the current contract honestly: Pause stops future polling but does not discard a response already in flight. Use injected bridge/deferred behavior, not module mocks or method spies. Control timers and external responses deterministically.

## Done criteria

- [ ] Detector generation, duplicate suppression, latest-callback, and unmount cases exist.
- [ ] Hydration and progressive-stream stale generation cases exist.
- [ ] Insight polling ownership and cancellation cases exist.
- [ ] Log pause, cursor, late completion, and unmount ownership are characterized.
- [ ] Mermaid source and lightbox controls have independent keyboard behavior tests.
- [ ] 603 existing tests plus all new tests pass.
- [ ] All 35 existing Playwright tests plus new browser cases pass.
- [ ] No production file changed.

## STOP conditions

- A test requires exporting a private production helper.
- The desktop bridge cannot provide a deterministic deferred seam without production changes.
- A proposed test requires relying on React keys or stateless DOM-node identity rather than product-visible behavior.
- Existing behavior contradicts the Review freshness or explicit Refresh contracts in `CONTEXT.md` and ADR-0017.

## Maintenance notes

These tests protect authority, stale-result, polling, and interaction rules, not the current ref implementation. Future code may use effects, stable events, reducers, or extracted controllers as long as these observable invariants remain. Conversation key cleanup in Plan 012 is a type-backed static correction because its current rows are stateless and cannot support an honest runtime regression test. Keep live Electron QA read-only unless a user explicitly authorizes a GitHub write.
