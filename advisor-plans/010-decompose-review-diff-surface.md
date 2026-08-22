# Plan 010: Decompose ReviewDiffSurface by state-machine concern

> **Executor instructions**: Preserve one primary Pierre CodeView owner, existing public props, measured scroll geometry, hydration settling, and comment-write safety. Extract one seam per commit and run focused tests after every slice. Final live Electron QA is mandatory and read-only.
>
> **Drift check (run first)**: `git diff --stat 4db4917..HEAD -- electron.vite.config.ts src/renderer/src/components/diff-workbench.tsx src/renderer/src/components/diff-worker-pool.tsx src/renderer/src/components/review-diff-view.tsx src/renderer/src/hooks/use-review-diff-hydration.ts src/renderer/src/hooks/use-review-diff-qa-scroll-diagnostics.ts src/renderer/src/review-diff-active-file.ts tests/renderer/review-diff-view.ui.test.tsx tests/browser/review-diff-keyboard-nav.spec.ts tests/browser/performance.spec.ts docs/adr/0026-prove-revision-identity-with-one-diff-renderer.md`
> Recent commits changed scroll geometry and performance coverage. Any drift in these files is load-bearing; reconcile exact behavior before editing.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/001-run-complete-test-gate.md`, `advisor-plans/002-enforce-safe-staged-quality.md`
- **Category**: tech-debt
- **Status**: `BLOCKED — live QA needs a clean Electron restart; the current local Electron binary is missing`
- **Planned at**: commit `4db4917`, 2026-08-21

## Why this matters

`ReviewDiffSurface` combines Pierre rendering, hydration, optimistic conversations, active-file geometry, range scrolling, three keyboard navigation state machines, themes, toolbar state, and annotation presentation. The responsibilities have distinct invariants and test needs. Extracting them into cohesive hooks/components reduces accidental coupling without creating a second diff implementation.

## Current state

`ast-grep outline` and direct reads at commit `4db4917` show:

- Public `ReviewDiffViewProps` lives at `src/renderer/src/components/review-diff-view.tsx:461-490`; keep it stable.
- `ReviewDiffSurface` starts at `:495` and its body runs to about `:2405`.
- Pierre/theme/viewer/hydration setup: `:495-704`.
- Existing `useReviewDiffHydration` is called at `:697`; do not duplicate it.
- Comment authoring and optimistic overlays: `:759-1172`.
- Annotation projection, edits/deletes/resolution overlays: `:1009-1240`.
- Item construction and controlled hydration: `:1241-1363`.
- Active-file and range scrolling: `:1364-1509`.
- File navigation begins near `:1555`.
- Hunk navigation begins near `:1659`.
- Unresolved-conversation navigation begins near `:1778`.
- Toolbar, Pierre callbacks, and primary render site follow through about `:2405`.
- Annotation cards/composer presentation: `:2406-2811`.
- Public wrapper, region naming, large-diff selection, and accessible fallback follow at `:2813+`.
- A React Doctor giant-component suppression at `:494` acknowledges the component size.
- Recent commits through `4db4917` fixed measured active-file geometry, viewport isolation, scroll anchoring, racing diff tests, and animation-frame coalescing of active-file reads. Preserve those behaviors exactly.
- `src/renderer/src/components/diff-worker-pool.tsx` and `DiffWorkerPoolProvider` in `diff-workbench.tsx` now move Pierre syntax coloring off the main thread. Preserve that shared worker-pool ownership and Vite's `worker.format: "es"` setting.

Important clarification: ADR 0026 chooses one canonical GitHub diff producer for revision hashing. Separately, this UI plan adopts an explicit invariant that the primary virtualized surface keeps one mounted Pierre `CodeView` and one viewer ref. Do not create parallel renderers or hydration owners.

## Commands you will need

| Purpose          | Command                                                                    | Expected on success               |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------- |
| Diff UI          | `pnpm test -- --run tests/renderer/review-diff-view.ui.test.tsx`           | authoring/hydration UI cases pass |
| Helper tests     | focused command listed below                                               | all navigation/model tests pass   |
| Typecheck        | `pnpm typecheck`                                                           | exit 0 after each slice           |
| Build            | `pnpm build`                                                               | exit 0                            |
| Keyboard browser | `pnpm exec playwright test tests/browser/review-diff-keyboard-nav.spec.ts` | pass                              |
| Performance      | `pnpm test:performance`                                                    | budgets pass without weakening    |
| Accessibility    | `pnpm test:a11y`                                                           | pass                              |
| Complete tests   | `pnpm test:all`                                                            | pass                              |

## Suggested executor toolkit

- Use `ast-grep outline` before and after each extraction.
- Use the project `diffs` skill for Pierre API constraints.
- Use `patchdesk-electron-tester` for final read-only CDP QA.

## Scope

**Existing files in scope**:

- `src/renderer/src/components/review-diff-view.tsx`
- `tests/renderer/review-diff-view.ui.test.tsx`
- Existing focused diff helper tests only when imports move

**New modules**:

- `src/renderer/src/components/review-diff-authoring.tsx`
- `src/renderer/src/components/review-diff-file-header.tsx`
- `src/renderer/src/hooks/use-review-conversation-overlays.ts`
- `src/renderer/src/hooks/use-review-diff-model.ts`
- `src/renderer/src/hooks/use-review-diff-scroll-state.ts`
- `src/renderer/src/hooks/use-review-file-navigation.ts`
- `src/renderer/src/hooks/use-review-hunk-navigation.ts`
- `src/renderer/src/hooks/use-review-comment-navigation.ts`
- focused tests matching each extracted hook where current tests do not suffice

**Out of scope**:

- Replacing Pierre or changing Pierre options/themes.
- Changing diff parsing, source selection, canonical hashing, or revision identity.
- Changing keyboard bindings, accessible names, comment UX, or write contracts.
- Creating a second primary CodeView/viewer/hydration owner.
- Performance threshold changes.
- Removing or relocating `DiffWorkerPoolProvider`, changing its worker/highlighter policy, or changing `electron.vite.config.ts` worker format.
- ReviewWorkbenchFlow refactor; Plan 009 owns it.
- Removing intentional accessible/nonvirtualized rendering used by walkthrough/finding surfaces.

## Git workflow

- Branch: `refactor/review-diff-surface`
- One commit per extraction. Suggested subjects:
  - `refactor(diff): extract presentation helpers`
  - `refactor(diff): extract keyboard navigation hooks`
  - `refactor(diff): extract scroll state`
  - `refactor(diff): extract conversation overlays`
- Never combine behavior fixes with the extraction unless separately approved and tested first.

## Steps

### Step 1: Freeze the invariants with characterization tests

Before moving code, confirm existing coverage passes:

```bash
pnpm test -- --run tests/renderer/review-diff-view.ui.test.tsx tests/renderer/review-diff-active-file.test.ts tests/renderer/review-diff-data.test.ts tests/renderer/review-diff-item-version.test.ts tests/renderer/review-diff-keyboard-nav.test.ts tests/renderer/review-diff-order.test.ts tests/renderer/use-review-diff-hydration.test.ts tests/renderer/review-context-control.test.ts
```

Add characterization only for an extraction seam not observable today. Do not change assertions to match a refactor.

Record these load-bearing invariants in test names/comments where absent:

- hydration does not mutate CodeView items while scrolling;
- active file comes from measured rendered geometry;
- scroll events notify the settling debounce at event cadence while active-file geometry reads are coalesced to one animation frame and use the latest `codeView.getScrollTop()`;
- current keyboard target is not replaced by transient scroll state;
- unknown write outcomes do not become retryable success/failure;
- controlled item versions change when annotation/hydration content changes.

**Verify**: baseline focused command passes before source movement.

### Step 2: Extract pure presentation helpers

Move file-header types/components and authoring card/composer presentation out first:

- `FileChangeCounts`, file type icon/label, path splitting, and `FileHeaderRow` → `review-diff-file-header.tsx`;
- `PendingConversationCard`, `PendingReviewWriteCard`, `PendingReviewThreadCard`, `LocalCommentThread`, avatar, error mapping, and `InlineCommentComposer` → `review-diff-authoring.tsx`.

Keep props explicit and render-only. Do not move state or network/write callbacks in this step.

**Verify**: diff UI tests, typecheck, and Oxfmt/Oxlint for the three touched files pass.

### Step 3: Extract keyboard navigation hooks one at a time

Create three hooks for file, hunk, and unresolved-conversation navigation. Each hook owns its current-target ref, boundary status, cancellation/generation token, effect, and command callback.

Reuse existing pure helpers such as `review-diff-keyboard-nav.ts`; do not duplicate algorithms. Inputs must be named, narrow values such as viewer handle/ref, ordered items, current selected path, focus guard, and scroll/materialize callback.

Order:

1. file navigation;
2. hunk navigation;
3. comment navigation.

After each move, run the pure keyboard tests and diff UI tests. Preserve text-field deferral and boundary announcements.

**Verify after each hook**: focused tests and typecheck pass; no keyboard binding changes.

### Step 4: Extract scroll and active-file state

Create `use-review-diff-scroll-state.ts` owning:

- viewer container accessibility setup;
- measured active-file viewport reads;
- active path resolution and updates;
- current requestAnimationFrame coalescing and unmount cancellation for active-path updates;
- scroll-settled integration;
- selected-range materialize-and-scroll behavior;
- transient interaction suspension and cancellation.

Keep the actual Pierre viewer ref owned by the thin surface and pass it into the hook. Do not create a second ref or viewer. Preserve current measured-item geometry and the recent viewport-isolation/scroll-anchor fixes; do not replace them with estimated whole-document positions.

**Verify**:

```bash
pnpm test -- --run tests/renderer/review-diff-active-file.test.ts tests/renderer/review-diff-keyboard-nav.test.ts tests/renderer/review-diff-view.ui.test.tsx
pnpm exec playwright test tests/browser/review-diff-keyboard-nav.spec.ts
pnpm test:performance
```

All pass without threshold changes.

### Step 5: Extract the diff model/hydration coordinator

Create `use-review-diff-model.ts` for:

- building the existing `useReviewDiffHydration` input;
- settled hydration selection;
- selected patch and ordered/visible file model;
- `CodeView` item construction;
- selected-line construction;
- controlled `reviewDiffItemVersion` values;
- context-control inputs and highlighter preload decisions.

The existing `useReviewDiffHydration` remains the sole hydration implementation. The new hook composes it; it does not reimplement source reads or maintain a competing hydrated-file store.

Return an explicit model consumed by the one surface render site.

**Verify**: hydration, item-version, order, data, context-control, and diff UI tests pass.

### Step 6: Extract conversation/authoring overlays last

Create `use-review-conversation-overlays.ts` owning:

- authoring selection and clear/start operations;
- created-thread and pending-write overlays;
- edited-body, deleted-comment, and resolved-thread local overrides;
- authoritative reconciliation effects;
- direct-comment save and pending-review add operations;
- displayed annotation projection and callbacks needed by renderer cards.

Preserve exact safety behavior:

- unknown outcomes do not offer blind retry;
- pending-review cards disappear only under the current authoritative rules;
- published controls use real receipt identities, never invented IDs;
- optimistic overlays survive until authoritative reconciliation says otherwise;
- fingerprints and patch locations remain unchanged.

Prefer a reducer if it makes state transitions explicit, but do not change behavior merely to adopt one. Add focused reducer/hook tests for transitions that are currently hidden in a 700-line UI test.

**Verify**: all diff UI authoring cases pass, including saved, pending, published, failed, unknown, edited, deleted, and resolved states.

### Step 7: Reduce ReviewDiffSurface to one coordinator/render site

The remaining `ReviewDiffSurface` should:

- own the one viewer ref and one primary Pierre render branch;
- call the extracted model, scroll, navigation, and overlay hooks;
- assemble toolbar and Pierre callbacks;
- render the CodeView/PatchDiff and extracted presentation components.

Keep `ReviewDiffViewProps` unchanged. Keep `ReviewDiffView`, region uniqueness, large-diff deferred selection, and accessible fallback behavior unless an extraction requires only import movement.

Remove the giant-component suppression only when React Doctor passes honestly. Do not replace it with a new suppression or a wrapper that hides the same body.

**Verify**:

```bash
ast-grep outline src/renderer/src/components/review-diff-view.tsx --view expanded
rg -n 'react-doctor-disable-next-line react-doctor/no-giant-component' src/renderer/src/components/review-diff-view.tsx
pnpm exec react-doctor --scope changed --base 4db4917 --yes
```

Expected: no giant-component suppression; the surface is a coordinator with one Pierre render site.

### Step 8: Run full renderer and live verification

```bash
pnpm typecheck
pnpm test:all
pnpm build
pnpm exec playwright test tests/browser/review-workbench.spec.ts tests/browser/review-diff-keyboard-nav.spec.ts
pnpm test:a11y
pnpm test:performance
```

Then restart the dev app with `pnpm dev -- --remote-debugging-port=9233`. Use `patchdesk-electron-tester` read-only against a real represented Review. Verify:

- initial virtualized diff and file tree;
- selected/all file modes;
- unified/split/wrap controls;
- navigator-to-diff scrolling and active file tracking;
- file, hunk, and unresolved-comment keyboard navigation;
- no interception inside text fields;
- existing comment cards and authoring affordance rendering without submitting;
- walkthrough/nonvirtualized embedded diff;
- logs contain no renderer errors, repeated hydration, or scroll loop.

Do not create, edit, resolve, dismiss, publish, or merge anything during live QA.

## Test plan

Retain browser tests for real Pierre focus, shadow DOM, scrolling, virtualization, and performance. Use jsdom/unit tests for extracted pure state and rendering. Never replace a browser proof with a hook test when layout is the behavior.

## Done criteria

- [x] ReviewDiffView public props and accessible behavior are unchanged.
- [x] One primary Pierre CodeView/viewer/hydration owner remains.
- [x] Presentation, three navigation state machines, scroll state, model/hydration coordination, and conversation overlays have cohesive owners.
- [x] Measured active-file and recent performance fixes remain intact.
- [x] Unknown write and optimistic reconciliation semantics are unchanged.
- [x] No giant-component suppression remains.
- [ ] Focused tests, `test:all`, typecheck, build, browser, accessibility, performance, staged quality, and live QA pass. Live QA is blocked by the local Electron installation: the pre-restart app rendered the Diff workbench but emitted CSP/WASM errors, and a clean restart failed with `Error: Electron uninstall` because the Electron binary is missing.
- [x] No thresholds, keyboard bindings, API contracts, or Pierre options changed.
- [x] `advisor-plans/README.md` is updated.

## STOP conditions

- An extraction mounts another CodeView or creates another viewer/hydration truth.
- An extraction bypasses or duplicates the shared Pierre worker pool, or moves active-file geometry work back to every raw scroll event.
- Active-file behavior would use estimates instead of measured rendered geometry.
- A performance failure is addressed by loosening a threshold.
- Optimistic UI invents remote identities, retries unknown outcomes, or drops overlays early.
- A keyboard or accessible-name behavior change appears necessary.
- A Pierre limitation requires a workaround not already documented/tested.
- Any intended functionality removal is discovered.

## Maintenance notes

Preserve rationale comments near Pierre workarounds; they describe shadow DOM, controlled item versions, scroll landing geometry, and virtualization constraints. Keep layout-sensitive proof in browser tests. Future diff features should enter through one of the extracted owners instead of growing the coordinator again.

## Verification record

- Extraction commits: `6d545d6`, `4d5ab4e`, `71a5ee7`, `51f6b81`, `b5b1cb0`, `5c57332`.
- Passed: focused renderer tests (8 files, 87 tests), `pnpm typecheck`, `pnpm test:all` (root 1,249 tests; Flue 15 tests), `pnpm build`, keyboard browser tests (9), performance tests, accessibility tests (20), staged quality, and React Doctor.
- Live evidence: the existing CDP app showed the Review Diff region, file tree, toolbar, and comment surface; screenshot saved at `/private/tmp/patchdesk-plan010-live-diff.png`.
- Blocker: the existing app was stale and emitted Shiki WASM CSP errors. Restarting the exact dev process chain failed with `Error: Electron uninstall`; the local Electron binary is absent.
