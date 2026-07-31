# Plan 012: Restore the Playwright baseline

> **Executor instructions**: Complete Plan 003 first. Diagnose each failure
> before editing. For every live browser check, the primary agent must dispatch
> a dedicated `patchdesk-electron-tester`; the tester owns interaction and
> returns screenshots plus concrete evidence. Update
> `advisor-plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- tests/browser/local-api-workbench.spec.ts tests/browser/protected-loopback-workflow.spec.ts tests/browser/review-workbench.spec.ts src/renderer/src/app.tsx src/renderer/src/flows/inbox-flow.tsx src/renderer/src/flows/settings-flow.tsx src/renderer/src/components/settings-modal.tsx src/renderer/src/components/pull-request-description.tsx src/main/local-api.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/003-deterministic-walkthrough-concurrency-test.md`
- **Category**: tests
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

The latest recorded browser run at the audited commit passed 56 of 60 tests.
Four failures cover direct workbench entry, workspace Settings selection,
Settings overlay return, and Mermaid sizing. A red browser baseline hides new
regressions and prevents Plan 013 from safely replacing mocked renderer seams.
Each failure needs a clean reproduction and the narrowest product or test fix,
without blanket timeout or threshold changes.

## Current state

The audit recorded these failures at the same source state:

- `tests/browser/local-api-workbench.spec.ts:17`: normal dashboard direct entry
  timed out opening the review workbench.
- `tests/browser/protected-loopback-workflow.spec.ts:68-101`: the workspace-root
  label matched both an input and a Remove button.
- `tests/browser/review-workbench.spec.ts:102-125`: returning from Settings
  overlay timed out.
- `tests/browser/review-workbench.spec.ts:552-571`: Mermaid SVG width was about
  126 px while the test requires more than 200 px.

Candidate source seams are explicitly limited to:

- `src/renderer/src/app.tsx` and `flows/inbox-flow.tsx` for direct route state;
- `flows/settings-flow.tsx` and `components/settings-modal.tsx` for Settings
  accessible names/return;
- `components/pull-request-description.tsx` for Mermaid sizing;
- `src/main/local-api.ts` only if direct-entry fixture composition is wrong.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `pnpm build` | exit 0 |
| Direct entry | `pnpm exec playwright test tests/browser/local-api-workbench.spec.ts -g "normal dashboard direct entry"` | one test passes |
| Protected loopback | `pnpm exec playwright test tests/browser/protected-loopback-workflow.spec.ts -g "renderer uses the protected loopback API"` | one test passes |
| Settings | `pnpm exec playwright test tests/browser/review-workbench.spec.ts -g "Settings stays"` | one test passes |
| Mermaid | `pnpm exec playwright test tests/browser/review-workbench.spec.ts -g "renders Mermaid"` | one test passes |
| Full browser | `pnpm exec playwright test` | all tests pass |

## Suggested executor toolkit

- Use `superpowers:systematic-debugging` or `diagnosing-bugs` for root-cause
  isolation.
- Use `patchdesk-electron-tester` for every live browser check. The tester
  should use `agent-browser` by default and return screenshots and DOM evidence.

## Scope

**In scope**:

- `tests/browser/local-api-workbench.spec.ts`
- `tests/browser/protected-loopback-workflow.spec.ts`
- `tests/browser/review-workbench.spec.ts`
- `src/renderer/src/app.tsx`
- `src/renderer/src/flows/inbox-flow.tsx`
- `src/renderer/src/flows/settings-flow.tsx`
- `src/renderer/src/components/settings-modal.tsx`
- `src/renderer/src/components/pull-request-description.tsx`
- `src/main/local-api.ts`

**Out of scope**:

- Increasing Playwright/test timeouts as the fix.
- Adding `force: true`, arbitrary sleeps, or retry loops.
- Lowering the Mermaid width requirement without a product/design decision.
- Changing the `<200ms` performance ceiling.
- Packaged Electron behavior unless a reproduced failure is package-specific.

## Git workflow

- Complete Plan 003. Stay on the current branch or use authorized
  `fix/playwright-baseline`.
- Prefer one commit per root cause, for example
  `fix: restore workbench direct entry` and
  `test: target workspace root control precisely`.
- Stage explicit in-scope paths. Do not push.

## Steps

### Step 1: Reproduce and classify each failure independently

Run `pnpm build`, then each focused command three times against the same built
surface. For every failure, record:

- whether the expected UI state is absent or only the selector is ambiguous;
- the final URL, visible heading/control, and relevant accessible name;
- console or request failure without secrets;
- a tester screenshot saved under `/tmp`, not committed.

Classify it as product regression, stale/ambiguous test, or no longer
reproducible. Do not edit during this step.

**Verify**: each focused command has three recorded outcomes and the dedicated
tester returns screenshots/DOM evidence for any live failure.

### Step 2: Repair direct workbench entry

If the route/state never reaches the workbench, fix only the relevant
`app.tsx`, `inbox-flow.tsx`, or `local-api.ts` composition and add an assertion
for the exact missing transition. If the product state is correct and the test
waits on a stale element, update the locator to a stable user-visible role/name.

Do not convert the test into a design-only mock path.

**Verify**:
`pnpm exec playwright test tests/browser/local-api-workbench.spec.ts -g "normal dashboard direct entry" --repeat-each=3`
→ 3 passes.

### Step 3: Target the workspace control precisely

Use role plus exact accessible name or a labeled form region so the workspace
input cannot match the Remove button. If the UI assigns the same accessible
name to unrelated controls, fix the source labels and keep both controls
usable by assistive technology.

**Verify**:
`pnpm exec playwright test tests/browser/protected-loopback-workflow.spec.ts -g "renderer uses the protected loopback API" --repeat-each=3`
→ 3 passes.

### Step 4: Repair Settings overlay return

Determine whether closing Settings loses the underlying route, focus, or
workbench state. Fix the source lifecycle when state is lost; otherwise replace
the stale locator with a stable visible workbench assertion. Preserve the
centered General-first overlay contract.

**Verify**:
`pnpm exec playwright test tests/browser/review-workbench.spec.ts -g "Settings stays" --repeat-each=3`
→ 3 passes.

### Step 5: Restore readable Mermaid geometry

Inspect the rendered SVG and its container. If product CSS constrains the
diagram to 126 px, fix the component/container so diagrams remain readable in
the overview drawer. If Mermaid's intrinsic dimensions legitimately changed
but the rendered diagram is still visibly readable, stop for a design decision
before changing the 200 px assertion.

**Verify**:
`pnpm exec playwright test tests/browser/review-workbench.spec.ts -g "renders Mermaid" --repeat-each=3`
→ 3 passes with measured width greater than 200 px.

### Step 6: Run the full required gate

Dispatch the dedicated tester for one final workbench/Settings/Mermaid live
pass and collect screenshots.

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test && pnpm package:mac && pnpm test:package-smoke`
→ every command exits 0.

## Test plan

- Three clean focused repetitions for each original failure.
- Full unit and Playwright suites.
- Package and package-smoke gates after renderer/desktop changes.
- Dedicated tester evidence for direct entry, Settings return, and Mermaid.

## Done criteria

- [ ] All four recorded failures are reproducibly fixed or explicitly proven
  stale after three clean runs.
- [ ] No timeout, sleep, forced action, or lowered threshold masks a failure.
- [ ] Full required gate passes.
- [ ] Dedicated tester returns screenshots and visible-state evidence.
- [ ] Only in-scope files and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- A failure does not reproduce in three clean built runs; report evidence and
  update the local task record rather than changing code.
- Fixing Mermaid requires lowering the design threshold.
- A package-specific issue appears outside the scoped source paths.
- No dedicated tester can be dispatched for required live verification.
- A focused verification fails twice after a root-cause fix.

## Maintenance notes

Keep locators user-visible and exact. Reviewers should reject timing-based
patches and require before/after evidence for every source change.
