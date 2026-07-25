---
created_at: 2026-07-24
status: draft
scope: Selection and scroll integration between Pierre tree and CodeView
sources:
  - 01-research-pierre-tree-diff-comments.md
---

# Pierre tree-diff scroll integration research

## Question

How should a file tree and a virtualized Pierre `CodeView` coordinate selection, scrolling, and streamed diff files?

## Answer

Use one shared, canonical file identity and make deliberate selection one-way:

```text
tree user action
  -> canonical path / CodeView item ID
  -> Patchdesk selected-file state
  -> hydrate or materialize the target diff item when needed
  -> CodeView.scrollTo(item or range)

finding or comment selection
  -> same selected-file state
  -> same CodeView scroll path

CodeView native user scroll
  -> progressive-stream observer only
  -> append more diff items when required
```

The tree and diff should retain separate native scroll containers. Do not continuously drive tree selection from `CodeView` scroll position, and do not call `CodeView.scrollTo` from its `onScroll` callback. Pierre's maintained DiffsHub integration follows this tree-to-diff selection pattern. It does not mirror every diff scroll back into the tree.

## Current Patchdesk behavior

Patchdesk already has the right ownership boundary without `@pierre/trees`:

- `CompletedReviewWorkbench` owns `selectedPath` and selected-finding state. Selecting a local `ChangedFileTree` row or a finding updates that state.
- `ReviewDiffView` maps the selected finding's old/new side to Pierre deletions/additions, ensures the file is available, then calls `CodeView.scrollTo` for the item or exact range.
- The diff viewport's `onScroll` belongs to the progressive all-files hook. It appends the next small batch near the end of the rendered content. It is not a navigation synchronizer.
- The local tree and the diff already have independent scroll areas. Browser coverage proves a tree selection moves the diff viewport to that file, and native wheel scrolling can stream the next diff file.

This is the appropriate integration model for the fixed desktop rail and the compact sheet.

## Official Pierre integration pattern

Pierre's DiffsHub application maintains an explicit `treePath -> CodeView itemId` map while parsing patches. It preserves patch order in the tree, supplies a bounded initial snapshot to the tree model, and batches subsequent streamed paths into the existing model. A tree selection resolves the item, expands it if necessary, updates its version, and calls `viewer.scrollTo({ type: "item", ... })`.

That matters because both components are virtualized:

- `CodeView` items have stable IDs and controlled version/collapsed state. Its public scroll API accepts an item, line, or range target.
- `useFileTree` creates its model once. New `paths` options are not automatically adopted later. Streamed updates must go through model methods such as `batch` and path-reset/update operations.
- `FileTreeController.scrollToPath` is imperative and does not itself change the selected path. It only works when the path is currently visible to the model.
- Pierre uses passive native scroll observation. A user wheel, touch, pointer, or keyboard scroll cancels a pending programmatic CodeView scroll rather than blocking the input.

## Why not make scrolling bidirectional?

Continuous diff-scroll-to-tree selection is a different feature, with a real feedback-loop risk:

1. The user scrolls the virtualized diff.
2. The host infers an "active" file and selects the tree row.
3. The tree selection callback scrolls the diff back to that file.

It also needs a robust active-file algorithm across virtual windows, collapsed hunks, progressive append, and renamed/deleted paths. Pierre exposes rendered items and scroll metrics, but not a simple public "current item at this scroll offset" contract. Adding a follower before that product behavior is specified would make native scrolling less predictable and conflicts with Patchdesk's existing Pierre boundary.

If a future design requires passive tree following, keep it separate from selection: throttle the derived active path, call `scrollToPath(path, { focus: false })` only to reveal it, never trigger `onSelectionChange`, and suspend following during a deliberate tree/finding navigation. That behavior needs its own interaction spec and regression coverage.

## Integration constraints and edge cases

- Keep exactly one canonical mapping between tree paths and diff item IDs. A display path alone is insufficient for renamed, deleted, or repeated patch entries. DiffsHub has explicit handling for those collisions.
- Tree selection must not bypass Patchdesk's selected-file owner. The existing owner is what keeps findings, diff range navigation, and keyboard navigation coherent.
- A selection can target a file not yet present in the current streamed CodeView window. Materialize or hydrate it first, then issue one intentional scroll after layout. Patchdesk already waits for range layout when it expands context.
- Do not steal focus while revealing the selected file in the tree. This is especially important when range navigation begins from a finding or inline comment.
- If filtering or collapsed directories hide the path, revealing it is not guaranteed. Treat that as a tree-state concern, not a reason to reset the diff or manufacture a selection.
- Preserve the current native scroll contract: no wheel/touch `preventDefault`, append-time scroll nudges, or global Pierre overrides.

## Proof to require if this is implemented later

- Selecting a tree entry updates the shared selected path and scrolls the diff exactly once.
- Selecting a newly streamed file works without resetting the tree model or losing the existing selection.
- Selecting a finding or inline comment uses the same identity path and lands on the correct additions/deletions range.
- Native wheel and keyboard scrolling in the diff do not change tree selection, do not scroll the page, and can still stream more files.
- Renamed, deleted, and repeated paths resolve to the intended diff item.
- The 1,000-file selection ceiling remains below 200ms, and the 1280px/1440px rails and compact sheet have no horizontal overflow.

## Evidence

Patchdesk current implementation:

- `/Users/kwanpham/Work/cfw/patchdesk/src/renderer/src/components/completed-review-workbench.tsx`: shared selected-file state, tree/finding callbacks, and the rail/diff composition.
- `/Users/kwanpham/Work/cfw/patchdesk/src/renderer/src/components/changed-file-tree.tsx`: local keyboard-accessible tree navigation.
- `/Users/kwanpham/Work/cfw/patchdesk/src/renderer/src/components/review-diff-view.tsx`: selected file/range to `CodeView.scrollTo` bridge.
- `/Users/kwanpham/Work/cfw/patchdesk/src/renderer/src/hooks/use-progressive-review-diff-stream.ts`: progressive append driven by CodeView scroll observation.
- `/Users/kwanpham/Work/cfw/patchdesk/tests/browser/milestone-9.spec.ts`: existing selection and native-scroll browser coverage.

Official Pierre source, pinned to the installed diffs release `1.2.12`:

- [DiffsHub file-tree streaming and selection mapping](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/apps/diffshub/components/DiffsHubFileTree.tsx)
- [DiffsHub tree selection to CodeView scroll](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/apps/diffshub/components/ReviewUI.tsx)
- [DiffsHub path-to-item identity mapping](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/apps/diffshub/lib/diffsHubDataAccumulator.ts)
- [CodeView React API and controlled-item reconciliation](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/packages/diffs/src/react/CodeView.tsx)
- [CodeView scroll-target types](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/packages/diffs/src/types.ts)

Official Pierre tree source, pinned to the installed trees beta `1.0.0-beta.5`:

- [FileTreeController selection and scroll behavior](https://github.com/pierrecomputer/pierre/blob/878e8fee0e65a6b6979f62dd6f2032f7c2b26214/packages/trees/src/model/FileTreeController.ts)
- [`useFileTree` model lifecycle](https://github.com/pierrecomputer/pierre/blob/878e8fee0e65a6b6979f62dd6f2032f7c2b26214/packages/trees/src/react/useFileTree.ts)

## Outcome

No application behavior changed. This note recommends preserving the existing selection-driven integration and treating any continuous tree-following behavior as a separate, explicitly designed feature.
