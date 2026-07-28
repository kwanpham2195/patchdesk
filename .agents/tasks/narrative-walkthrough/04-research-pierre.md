---
created_at: 2026-07-26
status: complete
scope: Pierre integration boundary for Patchdesk narrative walkthrough
canonical_packet: narrative-walkthrough
sources:
  - 01-research-pierre-tree-diff-comments.md
  - 02-research-pierre-tree-diff-scroll.md
  - src/renderer/src/components/review-diff-view.tsx
  - node_modules/@pierre/diffs@1.2.12
  - ./spec.md
---

# Pierre integration for narrative walkthrough — research

## Question

Does the approved hunk-first narrative walkthrough need a Pierre integration
spike before implementation, and which library surface should it use?

## Answer

Yes: do a small, implementation-first Pierre validation as part of the first
renderer slice. Do not make it a separate product-design project or add a new
diff library. Patchdesk already uses the installed `@pierre/diffs@1.2.12`
package for every capability the walkthrough needs at file/range granularity.

The approved experience needs a bounded, narrated group of patch hunks. Pierre
can render a parsed file (`FileDiff`) or a raw patch (`PatchDiff`), select a
side-aware range, and render typed annotations. It does not expose a public
React component that accepts a list of arbitrary hunk IDs as its primary
input. A selected range highlights a hunk inside a whole-file item; it cannot
reduce the rendered file to the requested hunks.

For a true hunk-only walkthrough block, Patchdesk must filter the immutable
raw patch text to the requested file headers and `@@` blocks, then parse that
new single-file patch through `processFile` or render it with `PatchDiff`.
Never shallow-filter `FileDiffMetadata.hunks`: its line indexes, layout
metrics, aggregate counts, and partial-file semantics would be inconsistent.

## Installed capability

- `FileDiffMetadata.hunks` exposes each `@@` block with stable parsed order,
  old/new start and count, and unified/split render metrics
  (`node_modules/@pierre/diffs/dist/types.d.ts`). This is sufficient to derive
  a Patchdesk-owned hunk identity from the immutable stored patch.
- `CodeView` accepts controlled `CodeViewDiffItem`s and has
  `scrollTo({ type: "range", id, range, align })`; its selected range is
  side-aware (`additions` or `deletions`) and file-scoped
  (`dist/react/CodeView.d.ts`).
- `FileDiff` renders one parsed file. `PatchDiff` renders raw patch text.
  Neither public React wrapper accepts a "render only hunks 2, 5" prop
  (`dist/react/FileDiff.d.ts`, `dist/react/PatchDiff.d.ts`).
- `CodeView` accepts typed line annotations and a `renderAnnotation` callback.
  Existing Patchdesk code already maps findings to that mechanism
  (`src/renderer/src/components/review-diff-view.tsx:201-228, 474-493`).
- `trimPatchContext` only reduces unchanged context in a whole patch. It is
  not a safe semantic-grouping API because it can split or rewrite hunk
  boundaries (`dist/utils/trimPatchContext.d.ts`).

## Patchdesk integration decision

Add a small, walkthrough-specific Pierre adapter rather than extend
`ReviewDiffView` with a range-only mode:

```text
Walkthrough section hunk aliases
  -> Patchdesk normalizer resolves exact immutable hunk ordinals
  -> adapter filters raw patch text to one file plus requested @@ blocks
  -> processFile or PatchDiff reparses the bounded patch block
  -> Pierre renders the bounded block with existing theme and annotations
```

This adapter is guide-local and must not mutate Files-mode `selectedPath`,
passive `activePath`, collapsed-file state, preferences, or the progressive
stream. It preserves the existing `ReviewDiffView` as the high-volume,
full-file Files surface. Each bounded block needs a unique ID because the same
source file can occur in non-contiguous walkthrough sections. Files mode
remains the full-file escape hatch.

For v1, render individual bounded blocks with `PatchDiff` or `FileDiff` using
the same Pierre theme/options and derived draft annotations. That is safe
because the active walkthrough section is deliberately bounded. A continuous,
virtualized walkthrough `CodeView` is a later optimization that needs a
dedicated group-item model; it cannot reuse the current path-as-item-ID model.

## Risks and required proof

- A hunk is not an independently renderable public React item. Do not clone
  or splice Pierre's parsed `FileDiffMetadata` structures to manufacture one;
  filter raw text and reparse so Pierre recomputes indexes and metrics.
- The filterer must preserve file headers, hunk order, deletion-only hunks,
  zero-count sides, renames, and missing unchanged context. The domain
  normalizer owns immutable hunk identity and rejects ambiguous anchors.
- The walkthrough's bounded block renderer does not need Files-mode
  virtualization. Do not introduce a competing scroll synchronizer or route
  guide navigation through `ReviewDiffView`'s native `onScroll` path.
- Annotations are derived display state. Walkthrough draft actions must update
  the existing review batch, then project the saved draft back into Pierre.
- The fallback `PatchDiff` is useful for small/non-virtualized test fixtures,
  but walkthrough production should preserve the existing `CodeView` path and
  1,000-file `<200ms` selection ceiling.

Required renderer proof before treating the integration as complete:

1. Filtering and reparsing a one-hunk block preserves its original old/new
   source line numbers in unified and split views for added, deleted, and
   mixed hunks.
2. A multi-hunk section renders groups in source order without resetting
   normal Files-mode selection or viewed-file controls.
3. A draft created from a focused hunk appears through the existing annotation
   path and remains available after Back to Files.
4. Large-patch selection remains under the existing performance ceiling.

## Outcome

Pierre research is necessary but bounded: it removes an API assumption before
the renderer task, while confirming the approved architecture needs no package
upgrade or alternative diff renderer. No application behavior changed.
