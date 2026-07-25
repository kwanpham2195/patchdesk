# Docked diff and passive file-tree follow design

## Decision

Keep Patchdesk's existing desktop grid. The application rail, review header,
file tree, diff toolbar, and inspector stay docked in the viewport. In **All
files** mode, only the Pierre CodeView diff scrolls. The file tree passively
highlights the file currently nearest the top of that diff viewport.

Dockview is not part of this change. It manages movable tabs, panels, saved
layouts, and pop-outs; Patchdesk needs a fixed review layout with independent
native scroll containers.

## Interaction

- The blue outer workbench never becomes the vertical scroll owner at desktop
  widths. Its rails have their own scroll containers; the red CodeView region
  owns review scrolling.
- In **All files** mode, the active file is the rendered diff item with the
  greatest top position at or above the CodeView viewport top. The highlight
  changes only when that path changes.
- The tree highlights the active file and minimally scrolls only when that row
  is outside the tree viewport. It never takes keyboard focus.
- Tree clicks and keyboard navigation keep their current meaning: they set the
  actual selected file and scroll the diff to it.
- Passive scrolling does not change the actual selected file, selected finding,
  selected range, inspector contents, draft state, or review context.
- **Selected** mode keeps the current explicit-file behavior. It does not
  continuously follow the diff because only one file is rendered.

## Design

`ReviewDiffView` gains an optional passive active-file callback. Its existing
CodeView scroll callback continues near-bottom streaming, then derives the
active path from Pierre's public item-top metrics for the rendered items. The
callback fires only for a changed path and only in **All files** mode.

Each workbench keeps two paths:

- `selectedPath`: explicit tree, finding, comment, or review-result navigation;
  it drives the header, inspector, and CodeView scroll target.
- `activePath`: passive reading position; it drives only the file tree's native
  row highlight and minimal reveal.

`PierreFileTree` accepts both paths. Programmatic active-path selection is
guarded so the tree's selection-change listener does not call the parent
navigation callback. Direct pointer and keyboard tree interactions remain
unaffected.

The current completed-review workbench already constrains its central diff
surface. Apply the same fixed-height, overflow-hidden boundary to the direct
read-only workbench so neither route lets the document scroll instead of the
CodeView.

## Boundaries and failure behavior

- Do not add wheel or touch handlers, `preventDefault`, append-time scroll
  nudges, DOM polling, or a second synchronization loop.
- If CodeView has no rendered item metrics during first paint, retain the last
  passive active path until the next native scroll callback. Do not clear the
  tree highlight.
- Streaming and hydration stay unchanged. When the next batch is appended, its
  first file becomes active only after it reaches the top-of-viewport rule.
- The active tree highlight is presentation state only; it is not persisted,
  submitted to GitHub, or exposed through review APIs.

## Verification

- Renderer tests cover active-file derivation, no callback in **Selected** mode,
  callback de-duplication, and separation of active and selected paths.
- Browser tests cover long-file transitions, streamed-file transitions, minimal
  tree reveal, unchanged inspector/finding selection, keyboard tree navigation,
  and no horizontal or page-level vertical overflow.
- Keep the 1,000-file selection ceiling below 200 ms and verify the packaged
  Electron app through CDP with native wheel/trackpad scrolling, console/error
  checks, and screenshots.
