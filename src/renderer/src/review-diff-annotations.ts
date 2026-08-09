import type { DiffLineAnnotation } from "@pierre/diffs";

import type { ReviewInlineAnnotation } from "./components/review-diff-view";

/**
 * Maps a review annotation onto a diff line slot for both the virtualized
 * code view and the non-virtualized walkthrough path.
 *
 * Range annotations (multi-line threads and findings) anchor at their final
 * line so a card appears after the last line it covers; the full range stays
 * in `metadata` for title and context rendering.
 */
export function toDiffLineAnnotation(
  annotation: ReviewInlineAnnotation,
): DiffLineAnnotation<ReviewInlineAnnotation | undefined> {
  return {
    side: annotation.side === "new" ? "additions" : "deletions",
    lineNumber: annotation.end,
    metadata: annotation,
  };
}
