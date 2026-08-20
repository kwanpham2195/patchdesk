export type ActiveFileItem = { readonly id: string };

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
    // this to "largest viewport overlap": with files at tops 0/240/520 and
    // scrollTop 239, that rule picks the third file, jumping the highlight
    // ahead of the reader (rejected -- see review-diff-active-file.test.ts).
    const reachableAndAtOrAboveTop = top <= scrollTop;
    const unreachableButVisible =
      top > maxScrollTop && top < scrollTop + viewportHeight;
    if (!reachableAndAtOrAboveTop && !unreachableButVisible) continue;

    activePath = item.id;
    activeTop = top;
  }

  return activePath;
}
