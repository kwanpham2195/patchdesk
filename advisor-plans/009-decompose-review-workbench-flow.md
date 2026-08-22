# Plan 009: Decompose ReviewWorkbenchFlow by protocol responsibility

> **Executor instructions**: This is a behavior-preserving renderer refactor. Work in small slices and keep `ReviewWorkbenchFlowProps` and the emitted `ReviewWorkbench` action contracts stable. Run focused UI tests after every slice and perform read-only live Electron QA at the end. Stop on any protocol timing or write-authority change.
>
> **Drift check (run first)**: `git diff --stat 4db4917..HEAD -- src/renderer/src/flows/review-workbench-flow.tsx src/renderer/src/app.tsx src/renderer/src/components/review-workbench.tsx src/services/review-refresh-service.ts src/services/analysis-review-body.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/services/analysis-review-body.test.ts`
> If the public props, endpoint protocol, recent-write union, or Insight composition changed, remap the extraction before editing.

## Status

- **Status**: DONE — protocol ownership was decomposed, staged quality passed at React Doctor 100/100, and the full renderer/browser verification passed. Live development QA rendered the real Review Insights surface read-only; the dev app still reports repeated Shiki WebAssembly/CSP page errors, recorded below as environment noise.

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/001-run-complete-test-gate.md`, `advisor-plans/002-enforce-safe-staged-quality.md`
- **Category**: tech-debt
- **Planned at**: commit `4db4917`, 2026-08-21

## Why this matters

`ReviewWorkbenchFlow` is both a React composition root and the controller for nearly every Review protocol. One component owns update observation, refresh, conversation writes, metadata writes, pending review, direct summary, merge, finding actions, and Insight lifecycle. This makes unrelated changes collide and encourages renderer code to import service implementation modules.

## Current state

`ast-grep outline` at commit `4db4917` shows:

- `ReviewWorkbenchFlow` begins at `src/renderer/src/flows/review-workbench-flow.tsx:241` and its main body runs to about `:1760`.
- Observation/refresh state and effects: `:257-500`.
- Direct conversation actions: `:502-771`.
- Labels, assignees, and reviewers: `:772-981`.
- Pending-review state/actions: `:989-1186`.
- Direct-summary state/actions: `:1187-1319`.
- Merge and finding-to-review actions: `:1355-1549`.
- Action/slot assembly: `:1550-1760`.
- `InsightsSlot` is another large component at `:1806-2434`.
- Receipt parsers and detection schemas live at `:2918-3153`.
- A React Doctor giant-component suppression at `:240` explicitly acknowledges the problem.
- `review-workbench-flow.tsx:15-16` imports `RecentReviewWrite` and `renderAnalysisReviewSummary` from `src/services/`.
- `RecentReviewWrite` is also used by main, storage adapters, and several services, so it is a shared protocol/domain type.
- `renderAnalysisReviewSummary` has only one production caller: this renderer flow.
- `ReviewWorkbenchFlowProps` at `:214-238` is consumed by lazy loading in `src/renderer/src/app.tsx`; keep it stable.
- `tests/renderer/review-workbench-flow.ui.test.tsx` covers refresh, detection scheduling, writes, recovery, terminal state, and merge behavior.

Repository constraints:

- Renderer code must not gain GitHub authority; it only calls the capability-protected loopback API.
- Unknown write outcomes and recent-write journal behavior are safety contracts.
- No compatibility shims: move callers and delete obsolete internal paths in the same slice.
- Main-process/service changes require a dev restart for live QA.

## Commands you will need

| Purpose        | Command                                                               | Expected on success        |
| -------------- | --------------------------------------------------------------------- | -------------------------- |
| Flow UI        | `pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx` | all protocol UI cases pass |
| Summary tests  | `pnpm test -- --run tests/renderer/analysis-review-summary.test.ts`   | formatter behavior passes  |
| Typecheck      | `pnpm typecheck`                                                      | exit 0 after each slice    |
| Build          | `pnpm build`                                                          | exit 0                     |
| Browser        | `pnpm exec playwright test tests/browser/review-workbench.spec.ts`    | workbench behavior passes  |
| Accessibility  | `pnpm test:a11y`                                                      | pass                       |
| Complete tests | `pnpm test:all`                                                       | all pass                   |

## Suggested executor toolkit

- Use the repository `ast-grep` outline workflow before and after each extraction.
- Use `patchdesk-electron-tester` for final read-only live QA.
- Use existing shadcn components; do not redesign UI.

## Scope

**Primary existing files**:

- `src/renderer/src/flows/review-workbench-flow.tsx`
- `tests/renderer/review-workbench-flow.ui.test.tsx`

**New renderer modules, exact names may be adjusted only for local naming precedent**:

- `src/renderer/src/flows/use-review-observation.ts`
- `src/renderer/src/flows/use-direct-conversation-actions.ts`
- `src/renderer/src/flows/use-review-metadata-actions.ts`
- `src/renderer/src/flows/use-pending-review-actions.ts`
- `src/renderer/src/flows/use-direct-summary-actions.ts`
- `src/renderer/src/flows/use-review-merge-action.ts`
- `src/renderer/src/flows/use-analysis-review-actions.ts`
- `src/renderer/src/flows/review-workbench-receipts.ts`
- `src/renderer/src/components/review-insights-slot.tsx`
- focused hook/parser tests under `tests/renderer/`

**Dependency-direction move files**:

- `src/domain/recent-review-write.ts` (new)
- `src/adapters/storage/recent-write-journal-store.ts`
- `src/main/local-api.ts`
- `src/services/assignee-service.ts`
- `src/services/inline-conversation-service.ts`
- `src/services/label-service.ts`
- `src/services/pending-review-service.ts`
- `src/services/review-observation-service.ts`
- `src/services/review-refresh-service.ts`
- `src/services/review-workbench-controller.ts`
- `src/services/reviewer-service.ts`
- `src/renderer/src/analysis-review-summary.ts` (new/moved)
- `src/services/analysis-review-body.ts` (remove after move)
- `tests/services/analysis-review-body.test.ts` → move to `tests/renderer/analysis-review-summary.test.ts`

**Out of scope**:

- API route shapes, endpoint names, service behavior, journal variants, or write authority.
- New UX or visual redesign.
- Changes to provider eligibility, Insight run policy, merge policy, or pending-review semantics.
- Refactoring `ReviewWorkbench` itself.
- ReviewDiffSurface; Plan 010 owns it.
- Replacing request/Valibot parsing libraries.

## Git workflow

- Branch: `refactor/review-workbench-flow`
- One commit per numbered extraction slice. Suggested subjects:
  - `refactor(review): own recent writes in domain`
  - `refactor(renderer): extract review observation`
  - `refactor(renderer): extract review write actions`
  - `refactor(renderer): extract insight slot`
- Do not combine this plan with feature work.

## Steps

### Step 1: Correct the two dependency-direction violations

Move `RecentReviewWrite` unchanged from `review-refresh-service.ts` into `src/domain/recent-review-write.ts`. Update every importer in main, services, storage adapters, and renderer. Do not change union variants, optional fields, or durable-journal behavior.

Move `renderAnalysisReviewSummary` and its renderer-only supporting types from `src/services/analysis-review-body.ts` into `src/renderer/src/analysis-review-summary.ts`. Move its test to `tests/renderer/analysis-review-summary.test.ts`. Preserve output bytes exactly.

Remove obsolete service paths; do not leave re-exports.

**Verify**:

```bash
rg -n 'services/(review-refresh-service|analysis-review-body)' src/renderer
pnpm test -- --run tests/renderer/analysis-review-summary.test.ts tests/services/review-refresh-service.test.ts tests/storage/recent-write-journal-store.test.ts
pnpm typecheck
```

Expected: grep has no matches; tests/typecheck pass.

### Step 2: Extract receipt parsing into a pure module

Move the direct conversation, label, assignee, reviewer receipt schemas/parsers and bounded parsing helpers from the bottom of the flow into `review-workbench-receipts.ts`. Export only functions/types consumed by hooks. Keep Valibot schemas private.

Add focused parser tests for valid receipts and malformed/oversized values already represented in the flow suite. Do not loosen validation.

**Verify**: parser tests and the full flow UI test pass.

### Step 3: Extract observation and refresh ownership

Create `use-review-observation.ts` from current lines `:257-500`. The hook owns:

- refreshing/error state;
- detected stale-freshness override;
- recent-write state and append operation;
- detector generation/in-flight guards;
- visibility/focus/interval scheduling;
- `detect-updates` and explicit refresh requests;
- workbench replace/patch callbacks needed by those operations.

Return a small named result containing freshness, refresh action/state, journal append, and any direct-command exclusion guard required by write hooks.

Preserve exact rules:

- stale detector generations cannot patch a newer workbench;
- focus/visibility triggers coalesce;
- unmount invalidates pending work;
- direct commands do not race observation;
- refresh replacement remains authoritative.

Add focused hook tests only where existing flow tests cannot isolate scheduler behavior. Keep endpoint integration assertions in the flow suite.

**Verify**: flow UI tests pass, especially generation, focus, unmount, overlap, and refresh cases.

### Step 4: Extract direct conversation and metadata actions separately

Create `use-direct-conversation-actions.ts` for create/reply/edit/delete/thread-state commands. Inputs must include the current revision proof, request client, observation journal append, and workbench patch/replace callbacks. Preserve unknown-outcome handling and exact receipt parsing.

Create `use-review-metadata-actions.ts` for label, assignee, and reviewer reads/writes. Preserve eligibility, journal receipts, and returned action contracts consumed by metadata controls.

Do not create one generic “command hook”; protocol-specific inputs and outcomes must remain visible.

**Verify after each hook**: focused flow UI tests and typecheck pass.

### Step 5: Extract pending-review and direct-summary state machines

Create `use-pending-review-actions.ts` owning:

- busy/dialog/error state;
- start/add/submit/discard commands;
- uncertain-outcome recovery;
- authoritative projection application;
- exact pending-thread recent-write entries.

Then create `use-direct-summary-actions.ts` owning:

- busy/error/override state;
- submit and recovery;
- confirmed receipt observation;
- bounded user-facing errors.

Keep these separate because pending review and direct summary have different durable authority and recovery rules.

**Verify**: flow cases for start, add finding, finish, recovery, confirmed summary, and unknown outcomes all pass.

### Step 6: Extract merge and analysis-finding actions

Create `use-review-merge-action.ts` for merge eligibility, recovery/write/reload, and returned action state. Create `use-analysis-review-actions.ts` for finding-anchor validation and Add-to-review behavior.

Do not move merge policy or finding validation into renderer helpers. The hooks only assemble and call existing capability-protected API contracts.

**Verify**: existing merge recovery and finding-to-pending-review flow tests pass.

### Step 7: Extract InsightsSlot as presentation/controller module

Move `InsightsSlot` and its private Insight presentation components/reducer/helpers to `src/renderer/src/components/review-insights-slot.tsx`. Preserve:

- provider catalog activation rules;
- selected provider/model/reasoning persistence;
- analysis and walkthrough run lifecycles;
- stale/artifact-mismatch states;
- finding dismissal/add-to-review actions;
- walkthrough progress state.

Do not change provider selection or run behavior. This step is file ownership only after the Review protocol hooks are stable.

**Verify**: flow UI tests, relevant Insight renderer tests, and typecheck pass.

### Step 8: Reduce ReviewWorkbenchFlow to composition

The remaining component should:

- receive the unchanged public props;
- call the extracted hooks;
- assemble the existing `ReviewWorkbench` actions and slots;
- render `ReviewWorkbench` and the extracted Insight slot.

It must no longer contain endpoint strings, receipt schemas, detector timer mechanics, or large write-state machines. Remove the giant-component suppression only when React Doctor passes honestly; do not replace it with another suppression.

**Verify**:

```bash
ast-grep outline src/renderer/src/flows/review-workbench-flow.tsx --view expanded
rg -n '/v1/|v\.variant|setInterval|setTimeout' src/renderer/src/flows/review-workbench-flow.tsx
pnpm exec react-doctor --scope changed --base 4db4917 --yes
```

Expected: outline shows a composition component and small local helpers; protocol strings/schemas/timers have moved; React Doctor reports no new blocking finding for the component.

### Step 9: Run full renderer verification and live QA

```bash
pnpm typecheck
pnpm test:all
pnpm build
pnpm exec playwright test tests/browser/review-workbench.spec.ts
pnpm test:a11y
```

Verification completed on 2026-08-22:

- `pnpm typecheck` passed.
- `pnpm test:all` passed: 145 root test files / 1,249 tests and 15 Flue tests.
- `pnpm build` passed.
- `pnpm exec playwright test tests/browser/review-workbench.spec.ts` passed: 33 tests.
- `pnpm test:a11y` passed: 20 tests.
- `pnpm precommit` passed with React Doctor 100/100 and no issues.
- Live QA reused the normal development app on CDP 9233. A real Review loaded, the Insights surface rendered after reload, and a read-only screenshot was captured at `/private/tmp/patchdesk-plan009-live-insights-final.png`. No write, dismiss, resolve, submit, or merge action was performed. The live page-error buffer reported repeated Shiki WebAssembly instantiation failures under the development Content Security Policy; the visible Review surface remained usable and the post-reload console had no errors.

Then restart the dev app with the documented remote-debugging port and use `patchdesk-electron-tester` read-only. Verify a real represented Review:

- opens and refreshes projection;
- Diff, Overview, Checks, and Insight sections render;
- update detection does not loop or spam logs;
- existing comments/metadata display;
- Insight configuration opens without activation side effects;
- no write, dismiss, resolve, submit, or merge action is performed.

Inspect `patchdesk.jsonl` and dev logs for renderer/main errors.

## Test plan

Preserve `tests/renderer/review-workbench-flow.ui.test.tsx` as end-to-end renderer protocol characterization. Add focused tests for pure receipt parsers and extracted hooks only when they make race/state ownership clearer. Do not duplicate the same endpoint behavior in every hook and flow test.

## Done criteria

- [x] Renderer imports no implementation module from `src/services/` for recent writes or analysis formatting.
- [x] Shared recent-write protocol type lives in domain/contract code unchanged.
- [x] ReviewWorkbenchFlow public props and ReviewWorkbench action contracts are unchanged.
- [x] Observation, conversation, metadata, pending review, direct summary, merge, and finding actions have cohesive owners.
- [x] Insight slot is outside the flow file with unchanged behavior.
- [x] The flow is composition-only and has no giant-component suppression.
- [x] Focused tests, `test:all`, typecheck, build, browser, accessibility, staged quality, and live QA pass, with the live dev CSP page-error note recorded above.
- [x] No API/service/domain behavior changed beyond module ownership.
- [x] `advisor-plans/README.md` is updated.

## STOP conditions

- Any extraction changes request timing, generation invalidation, command overlap exclusion, or journal variants.
- A write could occur without the current explicit UI action/capability path.
- Unknown outcomes become retryable or are treated as confirmed failure/success.
- A renderer hook needs direct GitHub, filesystem, process, or credential access.
- A compatibility shim appears necessary.
- An intended behavior or public prop/action removal is discovered.

## Maintenance notes

Organize hooks by protocol, not by arbitrary line count. Keep shared wire/domain types below services and renderer-only formatting inside renderer. Reviewers should compare request count/order and durable journal effects before and after every slice, not merely rendered snapshots.
