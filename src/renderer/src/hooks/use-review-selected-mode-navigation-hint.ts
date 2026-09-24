import {
  shouldIgnoreReviewNavKey,
  type ReviewDiffNavigationStatus,
} from "../review-diff-keyboard-nav";
import type { ReviewDiffNavigationOperation } from "./use-review-diff-navigation-feedback";
import { useKeyboardJump } from "./use-keyboard-jump";

function navigationKeyKind(
  key: string,
): ReviewDiffNavigationStatus["kind"] | undefined {
  switch (key) {
    case ",":
    case ".":
      return "file";
    case "[":
    case "]":
      return "hunk";
    case "{":
    case "}":
      return "comment";
    case "n":
    case "p":
      return "unviewed";
    case "v":
      return "viewed";
    default:
      return undefined;
  }
}

/**
 * Answers a file, hunk, or comment navigation key pressed in Selected mode
 * with a hint to switch to All files.
 */
export function useReviewSelectedModeNavigationHint({
  fileMode,
  createNavigationOperation,
  virtualized,
  browserSupportsPierre,
  markdownPreviewActive,
}: {
  readonly fileMode: "all" | "selected";
  readonly createNavigationOperation: () => ReviewDiffNavigationOperation;
  readonly virtualized: boolean;
  readonly browserSupportsPierre: boolean;
  readonly markdownPreviewActive: boolean;
}): void {
  // Selected renders only one file, so the navigation hooks stay off there and would otherwise leave the key silent.
  useKeyboardJump(
    virtualized &&
      browserSupportsPierre &&
      !markdownPreviewActive &&
      fileMode === "selected",
    (event) => {
      const kind = navigationKeyKind(event.key);
      if (kind === undefined || shouldIgnoreReviewNavKey(event)) return;
      event.preventDefault();
      createNavigationOperation().report({
        kind,
        state: "unavailable",
        message: "Keyboard navigation works in All files.",
      });
    },
  );
}
