# Plan 013: Replace mocked Pierre test seams

> **Executor instructions**: Complete Plan 012 first. Inventory assertions
> before deleting or rewriting any test. Every live browser verification
> belongs to a dedicated `patchdesk-electron-tester`. Update the index when
> complete.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- tests/renderer/docked-diff-state.ui.test.tsx tests/renderer/narrative-walkthrough-diff.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx tests/renderer/review-workbench.ui.test.tsx tests/browser/review-workbench.spec.ts src/renderer/src/components/diff-workbench.tsx src/renderer/src/components/narrative-walkthrough-diff.tsx src/renderer/src/components/narrative-walkthrough.tsx src/renderer/src/components/review-diff-view.tsx src/renderer/src/review-diff-active-file.ts src/renderer/src/review-diff-order.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/012-restore-playwright-baseline.md`
- **Category**: tests
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

Five renderer suites replace Pierre diff/tree modules with local mocks. Those
tests can pass while the real integration breaks, yet deleting them wholesale
would lose useful state and interaction assertions. Each assertion must move to
the lowest real seam that proves it: pure state logic, a real renderer
component, or the existing Playwright workbench.

## Current state

These suites mock the Pierre surface:

- `tests/renderer/docked-diff-state.ui.test.tsx`
- `tests/renderer/narrative-walkthrough-diff.test.tsx`
- `tests/renderer/narrative-walkthrough.ui.test.tsx`
- `tests/renderer/review-diff-view.ui.test.tsx`
- `tests/renderer/review-workbench.ui.test.tsx`

`tests/browser/review-workbench.spec.ts` already exercises the real file tree,
view controls, streaming, active path, keyboard navigation, viewed toggles,
scrolling, visual diff language, completed review, Mermaid, and multi-pane
geometry. Reuse that real coverage instead of creating another mock facade.

The test commands are split:

- renderer component tests: `pnpm test:ui`;
- real Chromium workbench: `pnpm exec playwright test
  tests/browser/review-workbench.spec.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Mock inventory | `rg -n "vi\\.mock|mocked" tests/renderer/{docked-diff-state.ui,narrative-walkthrough-diff,narrative-walkthrough.ui,review-diff-view.ui,review-workbench.ui}.test.tsx` | every Pierre mock is listed before work |
| Renderer | `pnpm test:ui` | all renderer tests pass |
| Browser | `pnpm exec playwright test tests/browser/review-workbench.spec.ts` | all workbench tests pass |
| Full gate | `pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test` | all commands exit 0 |

## Suggested executor toolkit

- Use `patchdesk-electron-tester` for live browser proof and screenshots.
- Use `ast-grep` to map mocked imports to production symbols before editing.

## Scope

**In scope**:

- `tests/renderer/docked-diff-state.ui.test.tsx`
- `tests/renderer/narrative-walkthrough-diff.test.tsx`
- `tests/renderer/narrative-walkthrough.ui.test.tsx`
- `tests/renderer/review-diff-view.ui.test.tsx`
- `tests/renderer/review-workbench.ui.test.tsx`
- `tests/browser/review-workbench.spec.ts`
- `src/renderer/src/components/diff-workbench.tsx`
- `src/renderer/src/components/narrative-walkthrough-diff.tsx`
- `src/renderer/src/components/narrative-walkthrough.tsx`
- `src/renderer/src/components/review-diff-view.tsx`
- `src/renderer/src/review-diff-active-file.ts`
- `src/renderer/src/review-diff-order.ts`

**Out of scope**:

- Pierre migration, upgrade, fork, or replacement.
- Changing product behavior merely to simplify tests.
- Removing assertions before equivalent real coverage exists.
- Weakening performance or visual assertions.
- Creating a second fake Pierre abstraction.

## Git workflow

- Complete Plan 012. Stay on the current branch or use authorized
  `test/real-pierre-seams`.
- Use commits by migrated behavior, for example
  `test: cover real Pierre navigation`.
- Stage explicit in-scope files. Do not push.

## Steps

### Step 1: Build an assertion inventory

For each of the five mocked suites, list every behavioral assertion in the
commit description or a temporary `/tmp` note. Assign exactly one destination:

1. pure state unit test for deterministic ordering/selection functions;
2. renderer test that mounts the real component and real Pierre imports;
3. Playwright workbench test using the production bundle;
4. reject as an implementation-detail assertion, with a one-line rationale.

Do not edit tests until every assertion has a destination. No assertion may be
deleted merely because similar test names exist.

**Verify**:
`rg -n "expect\\(" tests/renderer/{docked-diff-state.ui,narrative-walkthrough-diff,narrative-walkthrough.ui,review-diff-view.ui,review-workbench.ui}.test.tsx`
→ every listed assertion appears in the inventory.

### Step 2: Move pure state assertions to real pure seams

For active-file selection and ordering behavior, test
`review-diff-active-file.ts` and `review-diff-order.ts` directly through their
public functions. If a component currently hides deterministic logic, extract
only a pure function into one of those two existing modules; do not create a
generic test helper or change UI behavior.

Remove the corresponding mocked component assertions only after the pure tests
pass.

**Verify**:
`pnpm test:ui`
→ all renderer tests pass with the migrated pure assertions.

### Step 3: Replace component mocks where the real component can mount

For narrative walkthrough and review diff rendering, first attempt to mount the
real component with the smallest production-shaped props and browser APIs
provided by the current test environment. Remove `vi.mock` for Pierre modules
when the real import works.

If Pierre fundamentally requires layout/browser behavior unavailable in jsdom,
do not build a deeper mock. Move that behavior to Playwright in Step 4 and
retain only non-Pierre orchestration assertions at renderer level.

**Verify**:
`pnpm test:ui`
→ all renderer tests pass and no migrated assertion depends on a fake diff/tree
surface.

### Step 4: Fill only missing real-browser coverage

Compare the inventory with named tests already in
`tests/browser/review-workbench.spec.ts`. Add cases only for uncovered
user-visible behavior. Use stable roles/text and production fixtures. Preserve
existing visual and `<200ms` performance contracts.

Dispatch a dedicated tester for the new/affected behavior and collect a
screenshot showing the real Pierre surface.

**Verify**:
`pnpm exec playwright test tests/browser/review-workbench.spec.ts`
→ all tests pass with real Pierre modules.

### Step 5: Remove obsolete mocks and prove coverage

Delete obsolete mocked assertions or entire test files only when the inventory
maps all their value to passing real coverage. Do not ask whether a file looks
redundant; use the inventory.

**Verify**:
`rg -n "vi\\.mock\\([^\\n]*(pierre|diff)" tests/renderer`
→ no remaining mock of Pierre diff/tree modules in the five target suites.

### Step 6: Run full verification

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test && pnpm package:mac && pnpm test:package-smoke`
→ every command exits 0.

## Test plan

- Inventory every old assertion.
- Pure tests for ordering/active-file behavior.
- Real component tests where jsdom supports the dependency.
- Production Playwright tests for layout, scrolling, tree, and diff rendering.
- Dedicated tester screenshot of the real affected surface.

## Done criteria

- [ ] Every old assertion has a recorded real destination or rejection reason.
- [ ] Target suites no longer mock Pierre diff/tree modules.
- [ ] No new fake abstraction replaces them.
- [ ] Renderer, browser, package, and full repository gates pass.
- [ ] Dedicated tester evidence uses the real production bundle.
- [ ] Only in-scope files and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- Plan 012 is not green.
- Removing a mock exposes a real product defect; report it before rewriting the
  assertion.
- Equivalent coverage requires changing product behavior.
- A required file falls outside the in-scope list.
- No dedicated tester can be dispatched for live proof.
- A verification fails twice after a focused fix.

## Maintenance notes

Prefer pure logic tests and production-bundle browser tests over mocks of major
UI dependencies. Reviewers should compare the assertion inventory to the final
diff before accepting deleted tests.
