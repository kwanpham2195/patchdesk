import type { RefObject } from "react";
import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

export type MaterializeAndScrollOptions<T> = {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  /** Id the viewer must already hold for the scroll to land. Not necessarily
   * the id the final scroll target names (e.g. a range target scrolls by its
   * own id within this item). */
  readonly itemId: string;
  /** Checked before every attempt, including the first, and again right
   * before the final scroll. Lets the caller cancel a stale or
   * already-satisfied run without this function knowing why. */
  readonly isStale: () => boolean;
  /** Built once, right before the target is known to exist in the viewer. */
  readonly buildTarget: () => CodeViewScrollTarget;
  /** Whether the target's destination depends on a layout CodeView has yet to
   * recompute. Range and line targets resolve through the expanded-hunks map,
   * so they need the remeasure that follows an unchanged-hunk expansion; an
   * item target reads the item record directly and needs no wait. */
  readonly needsLayoutRecompute: boolean;
  readonly onScrolled?: () => void;
};

/** Frames a no-wait target retries on before it gives up on this run. */
const IMMEDIATE_TARGET_RETRY_FRAMES = 2;

/**
 * Scrolls `viewer` to a target item once the viewer holds it.
 *
 * A target that `needsLayoutRecompute` waits two animation frames before its
 * one attempt, so CodeView has remeasured line metrics after expanding a
 * selected unchanged hunk. Any other target is attempted immediately, then
 * retried on each of the next two frames until one scrolls -- on a first
 * mount the viewer may not hold the item yet, and without the retries a bail
 * would leave the pane unscrolled until `items` next changes.
 *
 * Returns a cleanup that cancels the pending animation frame; callers must
 * invoke it when the triggering condition changes or the component unmounts.
 */
export function materializeAndScrollTo<T>({
  viewer,
  itemId,
  isStale,
  buildTarget,
  needsLayoutRecompute,
  onScrolled,
}: MaterializeAndScrollOptions<T>): () => void {
  let pendingFrame: number | undefined;

  /** True once this run is finished, whether it scrolled or went stale. */
  const attempt = (): boolean => {
    // A newer target superseded this one while a stale frame from this
    // closure was still pending.
    if (isStale()) return true;
    const codeView = viewer.current;
    // The React item list is only what CodeView was last handed; the viewer's
    // own list is what a scroll resolves against, and the preview pane and
    // Scope filter can leave the two disagreeing. Ask the viewer.
    if (
      codeView === null ||
      codeView.getInstance()?.getItem(itemId) === undefined
    )
      return false;
    codeView.scrollTo(buildTarget());
    if (isStale() || viewer.current === null) return true;
    onScrolled?.();
    return true;
  };

  const cleanup = (): void => {
    if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
  };

  if (needsLayoutRecompute) {
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined;
        attempt();
      });
    });
    return cleanup;
  }

  let retriesLeft = IMMEDIATE_TARGET_RETRY_FRAMES;
  const attemptOrRetry = (): void => {
    pendingFrame = undefined;
    if (attempt() || retriesLeft === 0) return;
    retriesLeft -= 1;
    pendingFrame = requestAnimationFrame(attemptOrRetry);
  };
  attemptOrRetry();
  return cleanup;
}
