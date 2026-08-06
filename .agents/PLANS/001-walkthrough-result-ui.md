---
created_at: "2026-08-05"
repos:
  - patchdesk
status: BLOCKED
spec: .agents/tasks/unified-review-workbench/design/walkthrough-result-wireframe.html
---

# Plan 001: Make the Walkthrough result reader-first with a docked chapter rail

> **Executor instructions:** Follow this plan step by step. Run each verification command before moving to the next step. This is a renderer-only UI change. Do not change the Walkthrough domain schema, generation workflow, persistence, GitHub writes, Review draft semantics, or provider behavior.
>
> **Drift check (run first):** `git diff --stat c5e1f67..HEAD -- src/renderer/src/components/narrative-walkthrough.tsx src/renderer/src/components/narrative-walkthrough-diff.tsx src/renderer/src/components/review-workbench.tsx src/renderer/src/flows/review-workbench-flow.tsx src/renderer/src/components/review-draft-dock.tsx tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx`
>
> Also run `git status -sb`. Preserve unrelated work. The low-fidelity wireframe is currently an untracked design artifact at `.agents/tasks/unified-review-workbench/design/walkthrough-result-wireframe.html`; do not delete, reset, or overwrite it.

## Status

- **Priority:** P1
- **Effort:** M/L
- **Risk:** MED
- **Depends on:** none
- **Category:** direction / tech-debt
- **Implementation state:** Renderer implementation and full static gate complete; post-fix mobile CDP interaction proof is blocked by the tester hanging on a click against the development instance.
- **Planned at:** commit `c5e1f67`, 2026-08-05
- **Design reference:** `.agents/tasks/unified-review-workbench/design/walkthrough-result-wireframe.html`, Reader-first direction and its “Scroll model” note

## Why this matters

The Walkthrough result is useful and citation-backed, but the current renderer gives the result multiple competing vertical scroll owners. The outer Insights surface, the Walkthrough reader, the chapter rail, the diff viewer, Published feedback, and Review draft can all participate in scrolling or consume viewport height. A maintainer should be able to keep the chapter map visible, read one section, scroll a long diff without moving the reader, and understand citation coverage without losing their place. This plan makes that behavior explicit while preserving the existing revision-bound Insight and safe Review lifecycle.

## Product and design decisions

- The production result uses the wireframe’s **Reader-first** structure. Do not ship the wireframe’s three-direction selector as product UI.
- The existing outer Insights rail remains the navigation between `Overview`, `Analysis`, and `Walkthrough`. The inner Walkthrough chapter rail is a separate outline for the current Walkthrough document.
- Desktop scroll ownership is explicit:
  - the Walkthrough result owns the reader viewport;
  - the left chapter rail has its own bounded vertical scroll and stays docked beside the reader;
  - each diff block owns bounded vertical and horizontal scrolling;
  - the page must not create an additional full-document scroll container around the Walkthrough result.
- On narrow screens, the chapter rail becomes a horizontally scrollable section strip or disclosure region; it must not force page-level horizontal overflow.
- Keep the Review draft as the persistent collapsible bottom dock required by ADR 0004. Keep Published feedback as a supporting panel. They remain in normal flex flow and must not overlay the Walkthrough reader.
- Walkthrough remains read-only evidence. It may navigate back to Files, but it must not create inline comments or mutate GitHub state. ADR 0007 remains authoritative.
- Do not infer sentence-level citation positions from prose. Use the existing `NarrativeHunk.id`, path, hunk count, and section relationships to make section-level evidence explicit.
- Do not invent structured model fields by parsing prose. Render the current `title` and `focus` as a compact, labelled overview/disclosure; a future schema change is separate work.

## Current state

The following facts describe the code at planned commit `c5e1f67`.

- `src/renderer/src/components/narrative-walkthrough.tsx` renders the Walkthrough takeover. Its root is a flex column, its header keeps only the title, compact progress/provenance, and the overview disclosure; status/count badges and duplicate Files navigation are intentionally omitted from the reader chrome.
- `src/renderer/src/components/narrative-walkthrough.tsx:279-370` renders the chapter rail. The rail is an `aside` with `overflow-auto`; every section button repeats the full chapter title inside the button; the active button uses `aria-current`; Support is a collapsible group at the bottom.
- `src/renderer/src/components/narrative-walkthrough.tsx:371-450` renders the reading surface in a `ScrollArea`. It shows one active section, prose, a hunk-count badge, the existing legacy-citation alert, one `NarrativeWalkthroughDiff` per active hunk, review controls, a Support coverage card, reassurance copy, and reviewed-section progress.
- `src/renderer/src/components/narrative-walkthrough.tsx:135-232` already owns section indexing, reviewed IDs, current-section persistence callbacks, keyboard `ArrowLeft`/`ArrowRight`/`j`/`k` navigation, and focus transfer to the active section heading. Preserve those behaviors; improve their scroll synchronization rather than replacing them.
- `src/renderer/src/components/narrative-walkthrough-diff.tsx:96-116` wraps each filtered hunk in a plain `overflow-hidden` card and renders a file/hunk header before `ReviewDiffView`. The wrapper does not currently constrain height or establish a flex column, so the lower Pierre viewer cannot reliably receive the available height from the Walkthrough result.
- `src/renderer/src/components/review-diff-view.tsx:807-816` already gives the Pierre `CodeView` a `review-diff-viewport` with `overflow-y-auto`; the plan should constrain its parent rather than rewrite Pierre’s scrolling, hydration, annotations, or selection behavior.
- `src/renderer/src/components/review-workbench.tsx:290-365` gives the primary Tabs container a flex layout, but the Insights `TabsContent` is `overflow-auto p-6`. At `:368-374`, Published feedback and the Review draft dock are siblings below the Tabs content. The result must fill the remaining height without creating an outer Insights scroll that competes with the Walkthrough reader.
- `src/renderer/src/flows/review-workbench-flow.tsx:411-426` creates `NarrativeWalkthrough` with the retained projection, progress IDs, current section ID, raw patch, and persistence callbacks. No data-shape change is needed for this UI pass.
- `src/renderer/src/flows/review-workbench-flow.tsx:428-464` renders the outer Insights rail and an `article` with `overflow-auto` for every insight document. Analysis needs a document scroll; Walkthrough needs the outer article to become a bounded container so its own reader and chapter dock control scrolling.
- `src/renderer/src/components/review-draft-dock.tsx:31-44` keeps the draft in normal flow with a `max-h-[min(45vh,32rem)]` section and an inner `overflow-y-auto` content region. `src/renderer/src/components/published-feedback.tsx:44-53` uses a `max-h-[min(25vh,16rem)]` feedback region with its own scroll. Preserve the inner scroll behavior and use the smallest cap that keeps the Walkthrough reader usable at a 900px-tall desktop viewport.
- `tests/renderer/narrative-walkthrough.ui.test.tsx` covers first-mount focus, chapter/prose/Support rendering, unverified citation withholding, quiet reader chrome, Next/Previous, review actions, unique diff block IDs, the active diff, keyboard aliases, and Escape focus behavior.
- `tests/renderer/review-workbench-flow.ui.test.tsx` already covers the canonical workbench, Insights navigation, retained Walkthrough regeneration, and the `walkthrough-current` fixture. Add layout ownership assertions here only when they require the full workbench shell.
- `src/renderer/src/flows/app-fixtures.tsx:336-338` provides a one-section `walkthrough-current` fixture with persisted progress. Keep that fixture stable unless a long-result fixture is needed; prefer a test-local long Walkthrough builder for rail and diff overflow cases.

## Repository conventions and constraints

- Use strict TypeScript, existing Base UI/shadcn primitives, existing Tailwind utility conventions, and the project’s current `ScrollArea`, `Collapsible`, `Badge`, `Alert`, and `Button` components. Do not add a dependency or a second styling system.
- Match the Walkthrough vocabulary in `CONTEXT.md`: call it a `Walkthrough`, `Insight`, `Review`, `Review draft`, `Published feedback`, `Support`, `section`, `hunk`, and `current/outdated/failed` result. Do not call it a “model review” or “completed review.”
- ADR 0004 requires one persistent Review workbench with `Files` and `Insights` as primary surfaces and a persistent collapsible Review draft dock. ADR 0007 says Walkthrough may navigate to Files but cannot create GitHub inline-comment drafts. ADR 0012 keeps Analysis and Walkthrough independent. ADR 0013 keeps Walkthrough bounded, non-authoritative, and tool-free.
- Use the approved design artifact in `.agents/tasks/unified-review-workbench/design/`; do not create a `src/design/` source of truth.
- The live UI must be verified by a dedicated tester using `$patchdesk-electron-tester`. Unit tests and builds do not replace live evidence.

## Commands you will need

- `pnpm typecheck` — expected: exit 0 with no TypeScript errors.
- `pnpm lint` — expected: exit 0 with no ESLint warnings or errors.
- `pnpm exec vitest run tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx` — expected: all selected renderer tests pass.
- `pnpm build` — expected: main process, preload, and renderer build successfully.
- `pnpm test -- --run` — expected: the full suite passes. The baseline at plan creation has a known parallel temp-directory cleanup race in `tests/services/insight-run-coordinator.test.ts`; if it reproduces, run that test file in isolation, record the exact failure, and do not widen this plan to repair the unrelated race.
- Live QA: delegate to the dedicated `$patchdesk-electron-tester` agent. Use the development app, not a packaged app, with an isolated user-data directory and a fresh CDP port if the existing session cannot be reused. Capture desktop and narrow-mobile screenshots and inspect console/page errors.

## Suggested executor toolkit

- Read `.agents/skills/patchdesk-electron-tester/SKILL.md` before live QA.
- Use the existing `$shadcn` skill if a new disclosure, drawer, or scroll primitive is needed; prefer existing components before adding markup.
- Use the current `tests/renderer/narrative-walkthrough.ui.test.tsx` as the test-pattern exemplar. Do not use browser automation as a substitute for renderer tests.

## Scope

### In scope

- `src/renderer/src/components/narrative-walkthrough.tsx`
  - Establish the docked chapter/reader layout and explicit scroll ownership.
  - Restructure the result header into compact provenance, coverage, overview, and progress information without changing the model contract.
  - Group chapter buttons by chapter title instead of repeating the title on every item.
  - Keep the active chapter visible when selection changes and expose section progress/review state clearly.
  - Keep Support compact in the chapter dock; do not repeat a large global Support card for every section.
  - Add section-level evidence navigation using existing hunk IDs and paths.
- `src/renderer/src/components/narrative-walkthrough-diff.tsx`
  - Establish a bounded flex column for each diff card.
  - Expose the hunk ID/path as a stable evidence target.
  - Add a visible patch-only/context-unavailable explanation for Walkthrough evidence without changing generic diff semantics.
- `src/renderer/src/components/review-workbench.tsx`
  - Remove the competing outer Insights scroll owner and preserve the existing normal-flow bottom docks.
- `src/renderer/src/flows/review-workbench-flow.tsx`
  - Give the Insights slot and retained Walkthrough container the `min-h-0`/height contract required by the docked result while keeping Analysis/Overview readable.
  - Humanize retained-result timestamp/provenance copy if this can reuse an existing renderer helper without changing lifecycle data.
- `src/renderer/src/components/review-draft-dock.tsx` only if needed to keep the expanded draft within the agreed viewport budget; preserve its inner scroll and all write/recovery actions.
- `tests/renderer/narrative-walkthrough.ui.test.tsx`
  - Add regression coverage for grouped/active chapter navigation, evidence targeting, section progress, patch-only notice, and scroll ownership markers.
- `tests/renderer/review-workbench-flow.ui.test.tsx`
  - Add a full-shell regression for the retained Walkthrough container and docked Insights overflow contract.
- `tests/renderer/review-diff-view.ui.test.tsx` only if a generic diff class/prop must change; avoid touching this file for Walkthrough-only wrapper behavior.

### Out of scope

- `src/domain/narrative-walkthrough.ts`, workflow validation, citation verification, hunk indexing, persistence, or progress API shape.
- `src/services/insight-run-coordinator.ts`, invokers, command runner, local API, desktop bridge, provider catalogs, or Flue runtime.
- Any GitHub write, Review draft command, Published feedback mutation, merge action, or publication authorization behavior.
- A new sentence-level citation schema or prose parser.
- A replacement global side panel for Review draft or Published feedback; ADR 0004’s persistent bottom dock remains.
- A production visual redesign of the full workbench brand/theme. Keep styling within existing tokens and components.
- Packaging or packaged-Electron acceptance testing.

## Git workflow

- Do not switch branches, push, or commit unless the operator separately asks.
- Preserve the current `main` checkout and unrelated changes.
- If a commit is requested later, use the repository’s conventional commit style, for example `feat: ...` or `refactor: ...`, and stage explicit paths only.

## Implementation steps

### Step 1: Add characterization coverage for the result and scroll contract

Extend `tests/renderer/narrative-walkthrough.ui.test.tsx` with a test-local Walkthrough containing enough chapters/sections to exercise a long rail and at least one hunk with enough lines to require a bounded diff viewport. Add stable assertions for:

- a Walkthrough root marker such as `data-walkthrough-layout="docked"`;
- a distinct chapter dock region and reading region;
- exactly one active chapter button with `aria-current="true"`;
- selecting a non-initial section updates the active button, updates the section heading/prose, and calls `scrollIntoView` on the newly active chapter when the browser API is stubbed;
- `Next section` moves the reader to the next section and keeps the active section heading focus behavior already covered;
- the section progress and reviewed count are visible;
- hunk IDs/paths are exposed as evidence targets and the patch-only explanation is visible for a Walkthrough diff;
- the Support list remains compact and its review action still dispatches.

Do not assert Tailwind’s computed pixel values in jsdom. Assert semantic regions, data attributes, aria state, and the intended class/structure markers. Model the fixture after `buildWalkthrough()` already in this file.

**Verify:** `pnpm exec vitest run tests/renderer/narrative-walkthrough.ui.test.tsx` → existing tests plus the new result/scroll tests pass.

### Step 2: Make the workbench give Walkthrough one bounded viewport

Update `src/renderer/src/components/review-workbench.tsx` and `src/renderer/src/flows/review-workbench-flow.tsx` so the retained Walkthrough owns its reader scroll instead of competing with the outer Insights article:

1. Change the Insights `TabsContent` from an outer `overflow-auto` surface to a `min-h-0 flex-1 overflow-hidden` surface while preserving padding and the existing `keepMounted` behavior.
2. Ensure the Insights slot root and its desktop flex row have `min-h-0` and full available height.
3. Make the article wrapper use a bounded/hidden overflow class only for `selectedInsight === "walkthrough"`; retain a normal `overflow-auto` document surface for Insights overview and Analysis.
4. Keep the Published feedback and Review draft siblings in normal flex flow. Do not use `position: fixed`, absolute overlays, or a second global scroll container.
5. If the expanded Review draft still consumes the full reader at the supported desktop viewport, reduce only its visual max-height while retaining `data-review-draft-scroll` as the inner scroll region. Do not change any ReviewBatchPanel action or write gate.

**Verify:** `pnpm exec vitest run tests/renderer/review-workbench-flow.ui.test.tsx` → the existing workbench tests pass. Add an assertion that the retained Walkthrough path has the bounded Insights/reader markers and that Analysis still renders its document surface.

### Step 3: Build the docked chapter rail and reader surface

Refactor `src/renderer/src/components/narrative-walkthrough.tsx` without changing its action callbacks or persistence semantics:

1. Add an explicit full-height/minimum-height layout marker to the root. The header is a shrink-to-content region; the main result stage is `min-h-0 flex-1`.
2. Make the main stage a desktop two-column grid. The chapter dock is the left column with `min-h-0`, `overflow-y-auto`, stable width, and a visible current-section state. The reading surface is the right column and is the sole vertical reader viewport.
3. Group `walkthrough.chapters` into chapter headings with nested section buttons. Do not repeat a long uppercase chapter title inside every button. Keep `aria-current="true"` on the active section and reviewed indicators on reviewed sections.
4. On section selection, update the current section as today, call `scrollIntoView({ block: "nearest" })` on the active chapter button, and keep the existing heading-focus behavior for keyboard/Next navigation. Do not steal focus on initial mount.
5. Keep the existing arrow-key/`j`/`k` behavior and guard that prevents keyboard navigation from firing inside inputs, textareas, selects, contenteditable elements, and comboboxes.
6. Replace the long unlabelled `Focus:` header copy with a compact labelled overview/disclosure. Use the existing `walkthrough.title` and `walkthrough.focus` verbatim; do not split or rewrite generated prose. Keep compact provenance and reviewed progress near the result title, but do not add status/count badges to the reader chrome.
7. Move Support’s global count and `Mark Support reviewed` action into the compact chapter-dock disclosure. Remove or reduce the repeated Support coverage card at the end of every active section; the section reader should end with section review and navigation actions.
8. Keep Files as the parent navigation surface rather than duplicating a Back to Files button inside the Walkthrough. Walkthrough remains unable to add comments or draft items.

**Verify:** `pnpm exec vitest run tests/renderer/narrative-walkthrough.ui.test.tsx` → all Walkthrough UI tests pass, including focus, keyboard, section navigation, Support, and reviewed-state tests.

### Step 4: Make evidence and diff scrolling explicit

Update `src/renderer/src/components/narrative-walkthrough-diff.tsx` and only the generic diff boundary required for sizing:

1. Give the Walkthrough diff card a `flex min-h-0 flex-col` structure and a bounded height appropriate for the reader viewport. The file/hunk header and diff toolbar remain visible; the Pierre viewer receives the remaining height.
2. Keep the existing `ReviewDiffView` scrolling behavior (`review-diff-viewport` / `overflow-y-auto`) and contain horizontal overflow inside the diff. Do not rewrite hydration, annotations, virtualized/full-file behavior, or diff preferences.
3. Add `data-walkthrough-hunk-id` and an accessible label for every rendered hunk card. Use the existing hunk ID and repository-relative path.
4. Add a compact section-level Evidence row before the diff. Each evidence item is a button that scrolls to and focuses the matching hunk card. Do not claim sentence-level precision that the current model contract does not provide.
5. Add a visible patch-only/context-unavailable explanation for Walkthrough cards when exact file contents are unavailable. Keep the existing generic disabled context control and its truthful tooltip; the new copy should explain the limitation and direct the maintainer back to Files for full navigation.
6. Keep the existing `Unified`, `Split`, `Wrap/Scroll`, and context controls. Do not add a new diff implementation.

**Verify:** `pnpm exec vitest run tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx` → all selected tests pass, and the Walkthrough tests assert evidence targeting without requiring a real Pierre canvas.

### Step 5: Add full-shell and accessibility regression coverage

Extend `tests/renderer/review-workbench-flow.ui.test.tsx` using `createUnifiedReviewFixture("walkthrough-current")` and the existing `initialUiState` helper. Cover:

- opening the retained Walkthrough through the real Insights surface;
- the Walkthrough result has the docked chapter region and bounded reader markers;
- changing between Walkthrough and Analysis preserves each Insight’s independent surface behavior;
- the Review draft and Published feedback regions remain present as supporting siblings and do not become part of the Walkthrough reader DOM;
- the Walkthrough remains readable when its result is current and when it is outdated;
- no Walkthrough control exposes a GitHub write action.

Use accessible roles/names and stable data attributes, not brittle Tailwind class snapshots. If a test requires a new marker, add a meaningful semantic marker rather than a test-only styling hook.

**Verify:** `pnpm exec vitest run tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx` → all selected renderer tests pass.

### Step 6: Run the full code gate and live surface proof

Run the commands in this order:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm build`
4. `pnpm test -- --run`
5. Delegate live QA to a dedicated `$patchdesk-electron-tester` agent using the development app and an isolated user-data directory. Do not make GitHub writes or use the packaged app.

The live scenario must use a retained current Walkthrough with enough sections and hunks to exercise the layout. At a desktop viewport around 1440×900, verify:

- the chapter dock remains visible while the right reader scrolls;
- the chapter dock itself scrolls through long chapter lists;
- the diff code viewport scrolls vertically and horizontally without moving the chapter dock;
- selecting a chapter keeps the active button visible and moves the reader to that section;
- the Evidence control focuses the matching hunk;
- the patch-only explanation is understandable;
- collapsed and expanded Published feedback/Review draft do not overlay or permanently hide the reader;
- reviewed progress and Support remain visible/usable.

At a narrow viewport around 390×844, verify the chapter navigation reflows without page-level horizontal overflow and the diff remains contained. Capture one desktop and one mobile screenshot, inspect console/page errors, and record any blocker with its user-visible effect.

**Verify:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and the full test command exit successfully, subject only to the already-known isolated temp-directory race documented above. Live QA produces screenshots and a clean console/page-error report.

## Test plan

- **Chapter and scroll ownership:** extend `tests/renderer/narrative-walkthrough.ui.test.tsx` with a long local Walkthrough, active `aria-current`, `scrollIntoView` synchronization, section progress, and evidence target tests.
- **Diff boundary:** assert the Walkthrough diff card exposes a bounded semantic region and hunk ID; retain existing Pierre diff tests for generic scrolling and controls.
- **Workbench integration:** extend `tests/renderer/review-workbench-flow.ui.test.tsx` with retained current/outdated Walkthrough shell coverage and independent Analysis/Walkthrough surface assertions.
- **Accessibility:** use existing roles, `aria-current`, `aria-label`, `aria-controls`, and focus behavior. Run the live tester’s keyboard pass and, when feasible, `pnpm test:a11y` after the focused renderer gate.
- **Live proof:** the dedicated Electron tester owns the interactive development-app evidence. Do not claim success from unit tests or a build alone.

## Done criteria

- [ ] The Walkthrough has one explicit reader viewport; the outer Insights surface does not compete for vertical scrolling.
- [ ] The desktop chapter rail is visibly docked on the left, has its own bounded scroll, and keeps the selected section visible.
- [ ] The right reader can scroll independently; every long diff has contained vertical and horizontal scrolling.
- [ ] Diff/file headers and controls remain usable while code scrolls.
- [ ] The result header shows human-readable provenance, citation status, section/hunk coverage, and reviewed progress.
- [ ] The chapter rail groups sections without repeating the full chapter title in every item.
- [ ] Evidence rows use existing hunk IDs and paths, focus the matching diff block, and do not invent sentence-level citation semantics.
- [ ] Patch-only/context-unavailable state is visible and actionable without exposing raw provider output or hidden reasoning.
- [ ] Support stays compact and separate; Walkthrough does not create draft comments or GitHub writes.
- [ ] Review draft and Published feedback remain normal-flow supporting docks and do not permanently obscure the Walkthrough reader.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm lint` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] Focused renderer tests pass, including new regression coverage.
- [ ] Full-suite results are recorded, including the known temp-directory race if it reproduces.
- [ ] Dedicated live Electron QA provides desktop/mobile screenshots and a console/page-error report.
- [ ] No files outside the in-scope list are modified, except the plan/status artifacts explicitly requested by the operator.
- [ ] `.agents/PLANS/README.md` status row is updated to `DONE` or `BLOCKED` with a reason.

## STOP conditions

Stop and report instead of improvising if:

- Any current-state excerpt or component boundary differs materially from the planned commit.
- The intended docked layout requires changing `WorkbenchResponse`, Walkthrough persistence, the progress API, or the domain citation contract.
- Pierre’s `CodeView` cannot receive a bounded parent height without modifying generic diff semantics or breaking existing Files scrolling.
- The outer Insights surface cannot be made bounded without breaking Analysis/Overview scrolling; do not solve this by adding another nested scroll container.
- A proposed `Open in Files` interaction requires a new write or navigation contract not already available through `onBackToFiles`.
- The implementation would need to parse or rewrite model prose to create citations.
- A visual adjustment changes Review draft, Published feedback, publication, merge, or GitHub authorization behavior.
- Focus or keyboard navigation regresses in the existing Walkthrough UI tests.
- The full-suite failure is not the known `ENOTEMPTY` temp-directory race, or the isolated affected test fails.
- Live QA shows page/console errors, page-level horizontal overflow, an inaccessible chapter/diff scroll region, or a dock that overlays/loses the reader at the supported desktop/mobile sizes.

## Maintenance notes

- Keep the scroll contract documented near the Walkthrough layout. Future changes to `TabsContent`, `InsightsSlot`, `ReviewDraftDock`, or `PublishedFeedbackPanel` can reintroduce a competing scroll owner.
- If exact file hydration becomes available for Walkthroughs later, replace the patch-only notice with the real context status; do not silently enable a control that cannot work for retained snapshots.
- If product later requires sentence-level citations, add a versioned validated citation model and renderer contract rather than deriving positions from prose in the UI.
- Reviewers should scrutinize `min-h-0`, `flex-1`, overflow ownership, keyboard focus after section changes, and the behavior when both supporting docks are expanded.
- The low-fidelity wireframe intentionally defers final colors, typography, animation, and brand polish. Those belong in a later design pass after the structure is accepted and live scrolling is proven.
