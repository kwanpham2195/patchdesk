export type ActiveFileItem = { readonly id: string };

// Contract: `items` must be exactly the window CodeView has actually
// rendered and measured -- in practice, `codeView.getRenderedItems()` --
// never the full diff's item list. `getTopForItem` returns a real,
// measured top only for an item inside that window; for anything outside
// it, CodeView's `recomputeLayout` fabricates a top from an estimate (line
// count times an assumed line height), and that estimate shifts every time
// ANY item's layout is invalidated -- an annotation landing on some other
// file, a collapse toggle three files up, nothing to do with where the
// reader is scrolled to. Feed this function the full item list and one of
// those estimated tops can, for a moment, out-rank every real file's top,
// so the active-file highlight jumps to a file nowhere near the viewport.
// Restricting `items` to the rendered window guarantees every top this
// function compares was actually measured, not guessed.

// Geometry of the scrollable diff viewport at the moment of the query.
// `contentHeight` is the full scrollable height of the diff content (the
// viewport's `scrollHeight`), and `viewportHeight` is the visible height of
// the viewport itself (its `clientHeight`). Both are required to detect
// files that live in the final viewport-height of content -- see below.
export type ActiveFileViewport = {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
};

export function activeFilePathAtScrollTop(
  items: ReadonlyArray<ActiveFileItem>,
  viewport: ActiveFileViewport,
  getTopForItem: (id: string) => number | undefined,
): string | undefined {
  const { scrollTop, viewportHeight, contentHeight } = viewport;
  // A file whose top sits past this point can never be scrolled to the
  // viewport top -- the container physically cannot scroll that far, since
  // `scrollTop` is clamped to `contentHeight - viewportHeight`. Such a file
  // must be picked on plain visibility instead, or it could never become
  // active: not by scrolling to the very bottom, not by a keyboard jump.
  const maxScrollTop = contentHeight - viewportHeight;

  let activePath: string | undefined;
  let activeTop = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const top = getTopForItem(item.id);
    if (top === undefined || top <= activeTop) continue;

    // Every normally reachable file (top <= maxScrollTop) keeps strict
    // top-of-viewport semantics: it only becomes active once scrolled to the
    // very top, so the highlight never runs ahead of what the reader is
    // actually looking at. That strictness is relaxed to plain visibility
    // (top is within the current viewport) ONLY for files that are
    // unreachable by construction -- top past `maxScrollTop`. Do not widen
    // this to "largest viewport overlap": with files at (measured) tops
    // 0/240/520 and scrollTop 239, that rule picks the third file, jumping
    // the highlight ahead of the reader (rejected -- see
    // review-diff-active-file.test.ts). This reasoning assumes tops are
    // measured, per the module contract above -- it is exactly why an
    // estimated, unmeasured top must never reach this comparison at all.
    const reachableAndAtOrAboveTop = top <= scrollTop;
    const unreachableButVisible =
      top > maxScrollTop && top < scrollTop + viewportHeight;
    if (!reachableAndAtOrAboveTop && !unreachableButVisible) continue;

    activePath = item.id;
    activeTop = top;
  }

  if (activePath !== undefined) return activePath;

  // Neither branch above can ever match at a scrollTop inside the padding
  // gap above the window's first item. CodeView's own layout reserves
  // `paddingTop` (8px, see `DEFAULT_CODE_VIEW_LAYOUT` in
  // `@pierre/diffs/dist/constants.js`) before the first item, so that
  // item's real, measured top is 8, not 0 -- `getTopForItem` adds
  // `paddingTop` to every item's top (see `getTopForItem` in
  // `@pierre/diffs/dist/components/CodeView.js`). At scrollTop 0..7,
  // `reachableAndAtOrAboveTop` (`top <= scrollTop`) is false for that
  // first item, and `unreachableButVisible` also fails on any list taller
  // than the viewport, so the loop above finds nothing and the reader's
  // scroll position sits in a gap no item claims. That is not "no file is
  // active" -- it means the reader is looking at the very top of the
  // content, which is the first item in the rendered window by
  // definition. Per the module contract above, `items` is always
  // CodeView's rendered window, which always straddles the viewport, so
  // that window's first item with a measured top IS what is on screen;
  // falling back to it is reading the contract, not guessing. An item
  // list where every top is `undefined` has nothing on screen to report,
  // so it still falls through to `undefined` below.
  for (const item of items) {
    const top = getTopForItem(item.id);
    if (top === undefined) continue;
    return item.id;
  }

  return undefined;
}
