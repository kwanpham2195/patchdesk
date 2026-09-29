import { diffFindMatchRowCss, type DiffFindMatch } from "./review-diff-find";

/** The parts of Pierre's `CodeView` instance the mark reads. */
type RenderedDiffItems = {
  getRenderedItems(): ReadonlyArray<{
    readonly id: string;
    readonly element: HTMLElement;
  }>;
  subscribeToScroll(listener: () => void): () => void;
};

/** Frames the mark keeps looking for its file's element after it starts. */
const MARK_PLACEMENT_FRAMES = 30;

/**
 * Marks `match`'s row with a stylesheet inside its file's shadow root.
 *
 * CodeView renders only the files near the viewport and may hand a file's
 * element to another file after a scroll, so the stylesheet follows the
 * element CodeView currently renders for `match.path` on every scroll, and
 * leaves the DOM while that file is off screen. Returns the cleanup that
 * removes the mark.
 */
export function markDiffFindMatch(
  codeView: RenderedDiffItems,
  match: DiffFindMatch,
): () => void {
  const style = document.createElement("style");
  style.dataset.reviewDiffFindMark = match.path;
  style.textContent = diffFindMatchRowCss(match);
  const place = (): boolean => {
    const root = codeView
      .getRenderedItems()
      .find((item) => item.id === match.path)?.element.shadowRoot;
    if (root === null || root === undefined) {
      style.remove();
      return false;
    }
    if (style.parentNode !== root) root.append(style);
    return true;
  };
  const unsubscribe = codeView.subscribeToScroll(() => {
    place();
  });
  // A jump reports before CodeView's own render frame draws the target file.
  let pendingFrame: number | undefined;
  let framesLeft = MARK_PLACEMENT_FRAMES;
  const placeOrRetry = (): void => {
    pendingFrame = undefined;
    if (place() || framesLeft === 0) return;
    framesLeft -= 1;
    pendingFrame = requestAnimationFrame(placeOrRetry);
  };
  placeOrRetry();
  return () => {
    if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
    unsubscribe();
    style.remove();
  };
}
