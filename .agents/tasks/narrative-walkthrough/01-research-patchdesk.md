---
created_at: 2026-07-26
status: complete
scope: Patchdesk narrative walkthrough review mode
canonical_packet: narrative-walkthrough
sources:
  - ./02-research-codiff.md
  - src/renderer/src/components/diff-workbench.tsx
  - src/renderer/src/components/completed-review-workbench.tsx
  - src/renderer/src/components/review-diff-view.tsx
  - src/renderer/src/components/pierre-file-tree.tsx
  - tests/renderer/docked-diff-state.ui.test.tsx
  - tests/browser/performance.spec.ts
  - /Users/kwanpham/.cache/checkouts/github.com/nkzw-tech/codiff (ef1ec0343e544e4be0cdc88b9be31dc966bdc1e8)
  - ./03-research-plannotator.md
  - /Users/kwanpham/.cache/checkouts/github.com/backnotprop/plannotator (193b07e22c5312631b800c43f6a30d72d1a0d134)
---

# Patchdesk Narrative Walkthrough — research

## Question

What must a narrative, chapter-led review mode add to Patchdesk, and what existing behavior must remain intact?

## Current Patchdesk surface

Patchdesk is file-led. `DiffWorkbench` parses a stored unified patch, keeps a durable file-tree selection separate from the path passively visible at the top of the diff, then passes the patch into `ReviewDiffView` (`src/renderer/src/components/diff-workbench.tsx:39-56, 79-95, 129-220`). The completed-review workbench uses the same model and adds the optional findings inspector.

`ReviewDiffView` is a virtualized Pierre `CodeView`. It can show all files or the explicitly selected file, reports the passively active file while all-files mode scrolls, scrolls programmatically only for deliberate selection or finding navigation, and already owns split/unified, wrapping, context expansion, and viewed-file controls (`src/renderer/src/components/review-diff-view.tsx:188-309, 323-385, 401-472, 507-602`).

The `selectedPath`/`activePath` split is an explicit interaction contract: passive tree following may reveal and visually select the active item, but it must never invoke the explicit-selection callback. The regression coverage lives in `tests/renderer/docked-diff-state.ui.test.tsx:56-97`.

## Narrative-walkthrough reference

The referenced Codiff research describes an agent-authored, schema-validated sequence of chapters and hunk-anchored stops. A stop has a short semantic title, prose, importance, and one or more hunk aliases; anything outside the primary reading path becomes an explicit support section rather than disappearing (`02-research-codiff.md:37-63, 192-220, 239-320`).

The current upstream checkout confirms the interaction model: one navigation owner tracks `stop`, `support`, or `commit` mode, current index, visited stops, and scroll locks (`core/app/components/walkthrough/useNarrativeNavigation.ts:8-63, 155-234`). Its table of contents has review focus, chapter groups, numbered stops, progress states, and support coverage (`core/app/components/walkthrough/NarrativeSidebar.tsx:47-147`). The primary surface remains a continuous sequence of exact diff blocks, not a slideshow.

## Guided-review reference

Plannotator validates a second model: a mode takeover that hides the normal file tree and center dock while retaining the same live diff and annotation capability. Its guide is grouped at file level, with a sticky prose overview, one independent `Reviewed` state per section, and an explicit trailing bucket for unplaced files (`03-research-plannotator.md:24-67, 186-218`). The active upstream source confirms that the input must account for every changed file exactly once (`packages/server/guide/guide-review.ts:207-228, 969-1022`) and that the guide-specific reveal channel is separate from the hidden dock state (`packages/review-editor/App.tsx:245-265, 767-781`).

The strongest transferable rule is not the full takeover: guide/section completion must be distinct from ordinary per-file viewed state, and guide diffs must reuse the same review/annotation capability instead of creating a parallel comment model.

## Gap and constraints

Patchdesk has no walkthrough data model, generator, normalization boundary, coverage accounting, chapter navigator, or stop-level renderer today. Pierre renders parsed unified-patch files, not Codiff-style resolved hunk blocks, so a Patchdesk design needs a first-class mapping/model seam instead of copying the upstream UI.

The mode must preserve these rules:

- Do not merge semantic narrative navigation with the existing explicit-file versus passive-scroll state boundary.
- Retain the virtualized/hydrated CodeView path. The 1,000-file / approximately 10 MB selection performance guard remains below 200 ms (`tests/browser/performance.spec.ts:6-64`).
- Keep review snapshots read-only and retain the renderer/main-process security boundary from `AGENTS.md`.
- Keep direct file inspection available; the walkthrough organizes the first pass, it must not hide precise diff tools or mapped findings.
- Treat all ungrouped patch content as visible support coverage, never silently omit it.

## Design implication

The appropriate product shape remains a dedicated **Walkthrough** mode alongside the existing **Files** mode: a compact semantic rail on the left; a continuous, virtualized sequence of narrated diff groups in the centre; and the existing file-specific controls and inspector available on demand. The open design choice is whether Walkthrough is a full screen takeover like Plannotator or a hybrid view that retains the file rail like Codiff. In either direction, it should reuse the proven diff renderer and keep walkthrough completion independent of file viewed state.

## Confirmed product decisions

Walkthrough generation is manual. It runs only after a reviewer explicitly requests it; opening a snapshot or completing a review run must not generate a walkthrough implicitly.

Walkthrough is a focused screen takeover. It hides the normal file rail during reading, replaces it with semantic navigation and section progress, and provides one explicit action to return to the Files view.

Walkthrough completion is section-level and independent of file viewed state. Reviewing a walkthrough section must not mark its files viewed, and marking files viewed in Files mode must not complete a walkthrough section.

Walkthrough mode reuses the existing inline GitHub-comment draft flow. It does not introduce a second comment store or bypass existing explicit confirmation for remote writes.

Walkthrough sections group exact, semantically related patch hunks rather than whole files. Files mode remains the escape hatch for full-file inspection.

Generation failures and invalid output fail closed. V1 shows a concise error with Retry generation; it does not expose or accept raw model output for manual repair.
