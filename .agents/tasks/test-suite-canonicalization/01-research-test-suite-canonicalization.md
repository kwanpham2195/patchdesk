# Test suite canonicalization audit

## Question

Which Patchdesk tests and local artifacts no longer prove current behavior, and which tests remain the canonical suite?

## Sources read

- `AGENTS.md`
- `docs/agents/domain.md`
- `docs/agents/issue-tracker.md`
- `docs/agents/triage-labels.md`
- `package.json`
- `vitest.config.ts`
- `playwright.config.ts`
- `tests/`
- `src/`

## Baseline

`pnpm test -- --run` passed on 2026-07-30: 81 files and 564 tests. This establishes the pre-cleanup behavior. It does not validate browser or packaged-Electron flows.

The test tree has 20,607 lines. The bulk is meaningful boundary coverage: domain state, storage, local API capability checks, GitHub command handling, review orchestration, renderer behavior, accessibility, performance, and the permanent Design prototype.

## Keep

- All domain, service, storage, main-process, local-API, and GitHub adapter tests are current public-seam coverage. Each maps directly to its current production module. Examples: `tests/local-api-auth.test.ts` exercises `startLocalApiServer`; `tests/adapters/github-adapter.test.ts` exercises `GitHubAdapter` through `CommandRunner`; `tests/services/review-session-preparation.test.ts` exercises the current preparation orchestration.
- Keep `tests/services/review-attempt-artifacts.test.ts`. Its legacy `001` case proves the explicitly documented persisted-session compatibility contract in `src/services/review-attempt-artifacts.ts:43-58`.
- Keep `tests/browser/milestone-5.spec.ts`, `tests/browser/milestone-9.spec.ts`, `tests/browser/milestone-12.spec.ts`, `tests/browser/accessibility.spec.ts`, `tests/browser/performance.spec.ts`, and `tests/browser/design.spec.ts` as browser-level coverage. Rename the milestone files when applying the cleanup so their names describe the current behavior.
- Keep `tests/browser/milestone-9.spec.ts-snapshots/pierre-unified-darwin.png` and `pierre-split-darwin.png`. They are assertion baselines for `toHaveScreenshot` at `tests/browser/milestone-9.spec.ts:506-516`, unlike output screenshots.
- Keep `fixtures/flue/` and `fixtures/github/`. `tests/adapters/github-adapter.test.ts:29-99` reads the GitHub fixtures through the production adapter contract.

## Remove

### Generated results and one-off screenshots

`test-results/` is ignored and currently contains 30 generated files: 29 PNGs and `.last-run.json`. Delete the directory using Trash.

Remove the 19 nonasserting `page.screenshot({ path: "test-results/..." })` calls across these browser specs:

- `tests/browser/milestone-5.spec.ts`
- `tests/browser/milestone-7.spec.ts`
- `tests/browser/milestone-8.spec.ts`
- `tests/browser/milestone-9.spec.ts`
- `tests/browser/milestone-10.spec.ts`
- `tests/browser/milestone-11.spec.ts`
- `tests/browser/milestone-12.spec.ts`
- `tests/browser/design.spec.ts`

These calls generate inspection images but make no assertion. They are not visual regression tests. Retain only `expect(...).toHaveScreenshot(...)` assertions and their tracked baselines.

### Orphaned fixture inventory

`tests/fixtures/fixture-harness.test.ts` is the only source that reads `fixtures/scenarios/**` and `fixtures/screen-states/matrix.json`. `tests/setup.ts` only installs DOM polyfills; it does not load either fixture set. The screen-state audit PNGs are also unreferenced.

Delete:

- `tests/fixtures/fixture-harness.test.ts`
- `fixtures/scenarios/`
- `fixtures/screen-states/`

Update the stale fixture sentence in `AGENTS.md` when applying this deletion. It currently says those directories are loaded by `tests/setup.ts`; the source shows that they are not.

### Duplicated or obsolete tests

- Delete `tests/scaffold.test.tsx`'s first-run setup case. `tests/renderer/dashboard.ui.test.tsx:203-210` already proves the same rendered setup heading and Settings action through the full dashboard surface.
- Retain the `RendererRecovery` case, but move it into `tests/renderer/renderer-recovery.ui.test.tsx`. The current scaffold file groups two unrelated components.
- Delete `tests/browser/milestone-7.spec.ts`, `milestone-8.spec.ts`, `milestone-10.spec.ts`, and `milestone-11.spec.ts`. They drive test-only hash fixtures and duplicate focused behavior already owned by `diff-workbench.ui`, `docked-diff-state.ui`, `safe-run-panel.ui`, `merge-confirmation-dialog.ui`, `review-submission-service`, and `merge-service` tests.
- In `tests/adapters/github-adapter.test.ts:728-770`, keep the real `GitHubAdapter.resolveAuthenticatedAccount` assertion. Delete the `FakeGitHubAdapter` construction and assertion at `:741-769`: it only tests a test double alongside an unrelated production-boundary case.
- Rename `tests/services/milestone-5.test.ts` and its `describe` blocks. Its 11 assertions are current `ProfileSettingsService`, direct PR-entry, and `DashboardService` behavior. The stale phase name is the slop, not the coverage.

## Rewrite before retaining

Five renderer tests use `vi.mock(...)` to replace Pierre or renderer modules:

- `tests/renderer/docked-diff-state.ui.test.tsx`
- `tests/renderer/narrative-walkthrough-diff.test.tsx`
- `tests/renderer/narrative-walkthrough.ui.test.tsx`
- `tests/renderer/review-diff-view.ui.test.tsx`
- `tests/renderer/review-workbench.ui.test.tsx`

This conflicts with the project testing standard: tests should observe behavior through real seams and should not patch modules. Do not delete their behavior blindly. Replace the mocks with real component seams or move the covered behavior to the current browser workbench tests first. The audit did not find an equally complete real-surface replacement for every assertion.

## Out of scope

`.superpowers/` and `.pi-subagents/` are ignored local agent-work directories, not test results. They are not part of the test canonicalization change. Leave them alone unless their owner explicitly asks for local-agent cleanup.

`out/`, `release/`, and `node_modules/` are ignored build or dependency outputs. They are not test-result cleanup targets.

## Proposed canonical test layout

- `tests/domain/`: pure invariants and parsers.
- `tests/services/`: behavior through injected collaborators and persistence seams.
- `tests/storage/`, `tests/adapters/`, `tests/main-*`, `tests/local-api-auth.test.ts`: storage, external adapter, privileged boundary, and loopback API contracts.
- `tests/renderer/`: focused current component behavior with no module mocks.
- `tests/browser/`: protected loopback workflow, review workbench, completed workbench, accessibility, performance, and Design scenarios.
- `fixtures/flue/`, `fixtures/github/`, plus screenshot assertion baselines only where an active visual assertion consumes them.

## Verification after cleanup

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test -- --run`
4. `pnpm build`
5. `pnpm exec playwright test`

For any browser change, a dedicated tester agent must also run the affected live browser checks and provide screenshots. Packaged-app verification is unnecessary unless the cleanup changes desktop packaging or runtime assets.

## Application record

Approved cleanup applied on 2026-07-30.

- Removed the orphaned fixture harness, `fixtures/scenarios/`, `fixtures/screen-states/`, and four duplicated fixture-driven browser specs.
- Renamed retained current tests to `protected-loopback-workflow.spec.ts`, `review-workbench.spec.ts`, `local-api-workbench.spec.ts`, and `profile-dashboard-services.test.ts`.
- Moved the retained Pierre visual baselines to `review-workbench.spec.ts-snapshots/`.
- Removed all nonasserting `page.screenshot()` calls, rehomed the recovery component test, and removed the `FakeGitHubAdapter` assertion from the production adapter test.
- Removed generated `test-results/` output before and after browser QA. `trash-cli` repeatedly hung on macOS Trash metadata; its confirmed processes were terminated with approval, and the final browser-failure artifact directory was moved to the macOS Trash directly.

### Verification result

- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm test -- --run`: passed, 80 files and 534 tests.
- `pnpm build`: passed.
- `pnpm build:design`: passed.
- `pnpm exec playwright test`: blocked by four retained-test failures; 56 of 60 tests passed. The failures are outside the deleted coverage:
  - `local-api-workbench`: normal direct entry timed out.
  - `protected-loopback-workflow`: the workspace-root label matches both an input and its Remove button.
  - `review-workbench`: Settings overlay did not return to Inbox in time.
  - `review-workbench`: Mermaid SVG width was 126.421875, below the asserted 200 px.

The cleanup has no source-level `test-results/` or `page.screenshot()` writes. The four browser failures need a separate diagnostic/fix task before the complete Playwright gate can pass.
