# Plan 011: Keep scheduled React work bound to committed values

> **Executor instructions**: Follow this plan after Plan 010 is DONE. Preserve every token, generation, in-flight, and cancellation guard. Run each verification command before continuing. Update only this plan's status row in `plans/README.md` when complete.
>
> **Drift check (run first)**: `git diff --stat a3813b8..HEAD -- src/renderer/src/components/logs-panel.tsx src/renderer/src/flows/review-workbench-flow.tsx src/renderer/src/hooks/use-commit-diff.ts src/renderer/src/hooks/use-insight-run.ts src/renderer/src/hooks tests/renderer`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plans 009 and 010
- **Category**: bug
- **Planned at**: commit `a3813b8`, 2026-08-14

## Why this matters

React Doctor found 11 assignments to `ref.current` during render in four lifecycle-sensitive files. These assignments implement a deliberate latest-value pattern for timers and async completions, but render-time mutation can expose values from work React later abandons. Blindly moving writes to passive effects is also unsafe because scheduled work can observe stale values after commit. The target is a small committed-value primitive that updates before scheduled work can run, while all existing Review generation and cancellation rules remain unchanged.

## Current state

- `src/renderer/src/flows/review-workbench-flow.tsx:230-251` mirrors `workbench`, `recentWrites`, detected freshness, refresh state, and `onWorkbenchPatch` into refs during render. Detector work at `:250-401` reads those refs.
- `src/renderer/src/components/logs-panel.tsx:85-105` mirrors `paused` and `afterSeq` during render for the log poller.
- `src/renderer/src/hooks/use-commit-diff.ts:15-58` mirrors `loadCommitDiff` during render; its effect must call the latest loader without restarting only because the function identity changed.
- `src/renderer/src/hooks/use-insight-run.ts:45-190` mirrors three completion callbacks during render while polling owns run identity and cancellation.
- Plan 010 adds deferred-response and rerender characterization. Those tests are prerequisites and must remain green.
- Patchdesk targets React 19 but does not enable React Compiler. Do not assume an experimental event API is available from the minimum declared React version.

## Commands you will need

- Focused: `pnpm test -- --run tests/renderer/use-latest-committed.test.ts tests/renderer/use-commit-diff.test.ts tests/renderer/use-insight-run.test.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/logs-panel.ui.test.tsx`
- React Doctor JSON scan from Plan 009.
- Full: format, lint, typecheck, Vitest, build, Playwright, and `git diff --check`.

## Scope

**In scope**:

- `src/renderer/src/hooks/use-latest-committed.ts` (create; use a name that states committed semantics)
- `src/renderer/src/components/logs-panel.tsx`
- `src/renderer/src/flows/review-workbench-flow.tsx`
- `src/renderer/src/hooks/use-commit-diff.ts`
- `src/renderer/src/hooks/use-insight-run.ts`
- `tests/renderer/use-latest-committed.test.ts` (create)
- Plan 010 test files only when an assertion needs correction for the intended committed-value contract
- `plans/README.md` status row only

**Out of scope**:

- Refresh, pending-review, Insight, publication, or merge service contracts.
- Removing generation, token, in-flight, or cancellation refs.
- Adding dependencies.
- Enabling React Compiler.
- Fixing unrelated exhaustive-deps or component-size warnings.

## Git workflow

- Branch: `fix/react-committed-refs`
- Commit: `fix: bind scheduled work to committed values`
- Stage explicit paths only. Do not push unless instructed.

## Steps

### Step 1: Add a committed latest-value hook

Create a generic renderer hook that:

- creates one stable ref;
- updates it in `useLayoutEffect` after React commits and before browser-scheduled work can run;
- has no render-time assignment;
- documents why passive `useEffect` is not sufficient for timer/event consumers;
- does not use an experimental React API.

The initial ref value may come from `useRef(value)`; later values must only become visible after commit.

Add a StrictMode test proving the ref identity is stable, a committed rerender updates `.current`, and an uncommitted render cannot be asserted as current. Keep tests on the public hook contract.

**Verify**: `pnpm test -- --run tests/renderer/use-latest-committed.test.ts` passes and React Doctor reports no render-time ref mutation in the helper.

### Step 2: Migrate input-mirroring refs only

Replace only refs that mirror render inputs:

- `LogsPanel`: `pausedRef`, `afterSeqRef`.
- `ReviewWorkbenchFlow`: `workbenchRef`, `recentWritesRef`, `detectedStaleFreshnessRef`, `refreshingRef`, `onWorkbenchPatchRef`.
- `useCommitDiff`: loader ref.
- `useInsightRun`: completion callback refs.

Do not migrate mutable protocol refs such as request tokens, generation counters, active-run ownership, in-flight counts, or timer handles. Those refs are mutated inside effects/commands and are valid imperative state.

**Verify**: focused tests from Plan 010 pass after each file migration.

### Step 3: Check effect ordering and dependencies

For each migrated consumer, confirm the committed ref is updated before its polling/detection effect can read it. Do not add mirrored values to dependency arrays merely to silence a rule; that would restart timers and requests. Keep dependency changes only when a characterization test proves the old dependency set is wrong.

**Verify**: run the detector duplicate-suppression, latest callback, stale generation, commit-loader, and Insight terminal callback tests individually.

### Step 4: Prove the targeted diagnostics are gone

Run the calibrated full React Doctor scan. Assert there is no `no-ref-current-in-render` diagnostic in the four migrated files. Investigate any new diagnostic introduced by the helper; do not disable the rule.

```bash
pnpm exec react-doctor . --json --blocking none --yes --scope full --no-cache --json-out /tmp/patchdesk-react-doctor.json
jq -e '[.projects[].diagnostics[] | select(.rule == "no-ref-current-in-render" and (.normalizedFilePath == "src/renderer/src/components/logs-panel.tsx" or .normalizedFilePath == "src/renderer/src/flows/review-workbench-flow.tsx" or .normalizedFilePath == "src/renderer/src/hooks/use-commit-diff.ts" or .normalizedFilePath == "src/renderer/src/hooks/use-insight-run.ts"))] | length == 0' /tmp/patchdesk-react-doctor.json
```

Expected: `true`.

### Step 5: Run full and live verification

Run format, lint, typecheck, full Vitest, build, and full Playwright. Restart the Electron main process only if required by current dev state. Through the `patchdesk-electron-tester` skill, read-only verify:

- an existing Review opens;
- background update detection remains successful;
- changing tabs and returning does not duplicate detection;
- no new console/page errors appear;
- no GitHub write is triggered.

## Test plan

Use the characterization tests from Plan 010. The new helper test covers only its generic committed-value contract; ownership correctness remains proven at the real workbench, commit-diff, Insight, and log-panel seams.

## Done criteria

- [ ] No input-mirroring ref is assigned during render in the four targeted files.
- [ ] Protocol refs remain intact.
- [ ] All Plan 010 race and callback tests pass.
- [ ] React Doctor reports zero targeted `no-ref-current-in-render` occurrences.
- [ ] Format, lint, typecheck, full Vitest, build, and full Playwright pass.
- [ ] Read-only live Electron QA passes with no GitHub write.

## STOP conditions

- Plan 010 is not DONE.
- A migrated callback is observed stale between commit and the layout effect.
- Fixing a test requires weakening a stale-result or duplicate-request assertion.
- The change requires altering Review service or GitHub-write behavior.
- React Doctor still reports the helper solely because of a version-specific false positive; report the exact rule output before considering configuration.

## Maintenance notes

Use the committed-value hook only for asynchronous consumers that intentionally must not restart when input identity changes. Ordinary render data should stay as props/state, and protocol state should remain in explicitly owned refs or reducers. Reviewers must check that no authority-bearing generation or cancellation guard was removed as “cleanup.”
