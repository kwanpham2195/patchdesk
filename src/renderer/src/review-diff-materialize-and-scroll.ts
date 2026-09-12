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
   * before `onScrolled` fires. Lets the caller cancel a stale or
   * already-satisfied run without this function knowing why. */
  readonly isStale: () => boolean;
  readonly target: CodeViewScrollTarget;
  readonly onScrolled?: () => void;
};

/** Frames a no-wait target retries on before it gives up on this run. */
const IMMEDIATE_TARGET_RETRY_FRAMES = 2;

/**
 * Scrolls `viewer` to a target item once the viewer holds it.
 *
 * Range and line targets resolve through the expanded-hunks map, so they wait
 * two animation frames before their one attempt, giving CodeView the remeasure
 * that follows a selected unchanged hunk's expansion. An item target reads the
 * item record directly and is attempted immediately, then retried on each of
 * the next two frames until one scrolls -- on a first mount the viewer may not
 * hold the item yet, and without the retries a bail would leave the pane
 * unscrolled until `items` next changes.
 *
 * An immediate target reports through `onScrolled` a frame after the scroll,
 * because `CodeView.scrollTo` only records the target and queues its own
 * render frame: the viewport has not moved when it returns. Callers use
 * `onScrolled` to lower a "scroll in flight" flag, and lowering it early lets
 * the active-file poll read the pre-jump position and report the outgoing
 * file. The waiting path is already past that frame when it reports.
 *
 * Returns a cleanup that cancels the pending animation frame; callers must
 * invoke it when the triggering condition changes or the component unmounts.
 */
export function materializeAndScrollTo<T>({
  viewer,
  itemId,
  isStale,
  target,
  onScrolled,
}: MaterializeAndScrollOptions<T>): () => void {
  let pendingFrame: number | undefined;

  const reportScrolled = (): void => {
    if (isStale() || viewer.current === null) return;
    onScrolled?.();
  };

  /** True once this run is finished, whether it scrolled or went stale. */
  const attempt = (afterScroll: () => void): boolean => {
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
    codeView.scrollTo(target);
    afterScroll();
    return true;
  };

  const cleanup = (): void => {
    if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
  };

  if (target.type !== "item") {
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined;
        attempt(reportScrolled);
      });
    });
    return cleanup;
  }

  let retriesLeft = IMMEDIATE_TARGET_RETRY_FRAMES;
  const attemptOrRetry = (): void => {
    pendingFrame = undefined;
    // CodeView queues its render on a frame registered inside scrollTo, so a
    // frame registered right after it runs behind the applied scroll.
    const finished = attempt(() => {
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined;
        reportScrolled();
      });
    });
    if (finished || retriesLeft === 0) return;
    retriesLeft -= 1;
    pendingFrame = requestAnimationFrame(attemptOrRetry);
  };
  attemptOrRetry();
  return cleanup;
}
