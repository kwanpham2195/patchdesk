---
created_at: 2026-07-24
status: draft
scope: Pierre file tree, Patchdesk Pierre diff boundary, and inline review comments
---

# Pierre tree, diff, and inline-comment research

## Question

What is already integrated in Patchdesk, what do the installed Pierre packages
support, and what would be required to show editable review comments inside the
diff?

## Current Patchdesk state

Patchdesk declares `@pierre/diffs@^1.2.12` and
`@pierre/trees@1.0.0-beta.5` in `package.json`. Only the diffs package is
currently used in renderer source. `ChangedFileTree` is a local, flat,
keyboard-accessible list; it is not a Pierre tree.

The current diff path is deliberately narrow:

- `parseReviewDiff()` converts the immutable unified patch into Pierre
  `FileDiffMetadata` and derives addition/deletion counts.
- `useReviewDiffHydration()` requests only session-owned base/head content,
  then replaces a partial patch file with `processFile()` metadata. It
  de-duplicates requests and discards late results from an older session.
- `useProgressiveReviewDiffStream()` hydrates and appends five `CodeView`
  items at a time. Pierre remains the scroll owner.
- `ReviewDiffView` uses `PatchDiff` for a small/non-virtualized surface and
  controlled `CodeView` items for the all-files surface. It already uses
  Pierre selection and `scrollTo({ type: "range" })` to centre finding
  evidence.

This matches the existing Patchdesk constraint: hydration, streaming, and QA
scroll diagnostics remain separate hooks; the app does not intercept native
wheel/touch scrolling or inject global Pierre styling.

## Pierre tree

`@pierre/trees@1.0.0-beta.5` is a full path-first, hierarchical file tree. It
has a vanilla model plus React `useFileTree` and `<FileTree>` adapters, keeps
public identity as canonical path strings, and renders in a shadow root. It
supports selection, keyboard navigation, search, virtualized rendering,
prepared input for large path lists, git-status badges, and a row-decoration
lane.

It is a potential replacement for the current changed-file navigator only if
Patchdesk wants hierarchy, folders, built-in search, or a large-file virtual
tree. It is not a drop-in visual swap:

- Patchdesk currently preserves the API patch order and shows additions and
  deletions in every row. Pierre tree input is paths; its documented status is
  one Git status per path, while Patchdesk's two numeric counters would need a
  custom row decoration.
- The tree is shadow-root based. Patchdesk's normal Tailwind classes cannot
  style its rows; public CSS variables or the package's scoped `unsafeCSS`
  escape hatch would be needed. That needs a separate contrast, forced-colors,
  focus, and 208px-rail proof.
- The installed tree release is still labelled beta. A change should exercise
  its real renderer behavior, including controlled selection and restoring
  focus after a diff navigation, rather than assuming the local navigator's
  tests transfer unchanged.

No product change is implied by this research. The local navigator remains the
lower-risk choice when a dense flat list is the intended interface.

## Pierre diff integration

The installed `@pierre/diffs@1.2.12` supports a controlled `CodeView` whose
items can be updated by ID and versioned. It supports side-aware line/range
selection and item/line/range scrolling. Patchdesk already uses each of those
capabilities for file navigation, context hydration, and virtual streaming.

The key integration boundaries to retain are:

- The raw stored GitHub patch is the immutable coordinate source. `processFile`
  augments a matching raw file patch with exact saved old/new content; it must
  not be replaced by a fresh mutable pull-request diff.
- Hydrated files require a version bump before controlled CodeView sees the
  replacement. Patchdesk already does that through `reviewDiffItemVersion`.
- The library's `line-info` separators need complete file metadata to reveal
  omitted context. A partial raw patch alone cannot safely expose it.
- Patchdesk owns selected-finding semantics and its safe renderer projection;
  Pierre owns display, hunk expansion, virtualization, and scrolling.

## Inline comments: what Pierre provides

Yes: the installed release has a native annotation mechanism suitable for
placing a React comment card directly below a diff line.

For `CodeView`, each `CodeViewDiffItem<T>` can contain
`annotations: DiffLineAnnotation<T>[]`. An annotation carries `side`
(`"additions"` or `"deletions"`), a one-based `lineNumber`, and typed
metadata. The React `CodeView` receives `renderAnnotation(annotation, item)`.
Pierre maps the annotation to its slot and supplies the rendered React content;
it does not define a review-comment domain, editor, persistence, permissions,
or GitHub submission behavior.

Pierre's own annotation tests cover annotations after context, addition,
deletion, and expanded lines in unified and split views, plus the file-level
`lineNumber: 0` case. That proves placement behavior for the installed API; it
does not prove Patchdesk's draft lifecycle or GitHub mapping.

The maintained DiffsHub example demonstrates the complete library-facing
pattern:

1. Turn a selected range into a typed draft `DiffLineAnnotation`.
2. Add or replace it in the target CodeView item.
3. Increment the item's `version` and call `viewer.updateItem(item)`.
4. Render either a draft form or saved comment card via `renderAnnotation`.
5. Convert the result to application-owned saved-comment data.

This is relevant proof of Pierre capability, not code Patchdesk can copy as a
product integration. DiffsHub uses its own client state and demo data model.

## Gap between Pierre annotations and Patchdesk review comments

Patchdesk's current "Inline comments" are editable rows in `ReviewDraftSheet`.
They are persisted local review-draft comments and become GitHub comments only
after the existing explicit confirmation flow. A `DraftComment` is already
anchored to finding ID, repository path, line/range, old/new side, and
postability. The submission service only sends included, postable comments
after it verifies the current head.

Therefore an inline-diff UI would be a second editor for the same draft data,
not a new comment system. It must:

- project only safe `DraftComment`/finding data into the renderer;
- map GitHub's `old`/`new` side to Pierre's `deletions`/`additions` without
  changing line coordinates;
- update the local draft first, retain autosave/conflict behavior, and show
  postability honestly;
- preserve the exact saved revision plus current-head recheck and dedicated
  GitHub confirmation; and
- handle unavailable context, renamed/deleted files, collapsed files, and
  virtualized items without pretending a comment can be posted.

Pierre annotations are display state. They should be derived from the saved
draft and selected finding, then recomputed when controlled CodeView items are
hydrated, streamed, collapsed, or updated. Storing annotation state inside the
Pierre view would duplicate the draft and threaten the current write-safety
contract.

## Open product decisions

- Should annotations display only existing draft/finding comments, or should a
  user be able to select arbitrary changed lines and create a new draft?
- Is an inline card the primary editor, with the sheet retained as a complete
  accessible overview, or should the sheet remain the only editor?
- Should existing GitHub review threads also appear inline? Doing so requires
  a distinct read-only thread model; they are not Patchdesk draft comments.
- Does the changed-file navigator need hierarchy/search enough to justify the
  beta Pierre tree and shadow-root styling boundary?

## Evidence

### Patchdesk

- [`package.json`](../../../package.json): declares the exact installed Pierre
  versions.
- [`review-diff-data.ts`](../../../src/renderer/src/review-diff-data.ts):
  immutable-patch parsing and file totals.
- [`use-review-diff-hydration.ts`](../../../src/renderer/src/hooks/use-review-diff-hydration.ts):
  bounded hydration, de-duplication, and `processFile` replacement.
- [`use-progressive-review-diff-stream.ts`](../../../src/renderer/src/hooks/use-progressive-review-diff-stream.ts):
  five-file progressive CodeView stream and native scroll ownership.
- [`review-diff-view.tsx`](../../../src/renderer/src/components/review-diff-view.tsx):
  controlled CodeView items, selection/range scrolling, theme boundary, and
  library-managed hunk behavior.
- [`changed-file-tree.tsx`](../../../src/renderer/src/components/changed-file-tree.tsx):
  current local flat navigator; no Pierre-tree import.
- [`review-draft.ts`](../../../src/domain/review-draft.ts): durable draft
  comment anchor and postability contract.
- [`review-draft-sheet.tsx`](../../../src/renderer/src/components/review-draft-sheet.tsx):
  current sheet editor titled "Inline comments".
- [`review-submission-service.ts`](../../../src/services/review-submission-service.ts):
  filtered postable batch and current-head verification before GitHub writes.

### Pierre primary sources

- [`@pierre/diffs` 1.2.12 release source](https://github.com/pierrecomputer/pierre/tree/9466c467ae6fc03501b6bca74c12f717d70293a7/packages/diffs):
  installed-version source, release tag `diffs-v1.2.12`, Apache-2.0.
- [`diff annotation types`](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/packages/diffs/src/types.ts):
  side-aware `DiffLineAnnotation` and `CodeViewDiffItem.annotations`.
- [`React diff props`](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/packages/diffs/src/react/types.ts):
  `lineAnnotations` and `renderAnnotation` props.
- [`React annotation slot rendering`](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/packages/diffs/src/react/utils/renderDiffChildren.tsx):
  annotations are rendered through named slots.
- [`DiffsHub viewer`](https://github.com/pierrecomputer/pierre/blob/3b70f81a3009b16b44692d10473f3a2567b0bf10/apps/diffshub/components/DiffsHubViewer.tsx):
  maintained sample that mutates annotations, bumps item version, and calls
  `updateItem`.
- [`Pierre annotation tests`](https://github.com/pierrecomputer/pierre/blob/9466c467ae6fc03501b6bca74c12f717d70293a7/packages/diffs/test/annotations.test.ts):
  native placement coverage for unified, split, expanded, and file-level rows.
- [`@pierre/trees` README](https://github.com/pierrecomputer/pierre/blob/878e8fee0e65a6b6979f62dd6f2032f7c2b26214/packages/trees/README.md):
  path-first tree, React adapter, shadow-root boundary, and row decoration.
- [`@pierre/trees` release package manifest](https://github.com/pierrecomputer/pierre/blob/878e8fee0e65a6b6979f62dd6f2032f7c2b26214/packages/trees/package.json):
  confirms the installed `1.0.0-beta.5` package version.

## Research boundary

No application behavior, package version, or GitHub write path changed. This
note is ready for review before design or implementation work begins.
