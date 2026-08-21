import type { RefObject } from "react";
import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

export type MaterializeAndScrollOptions<T> = {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly items: ReadonlyArray<{ readonly id: string }>;
  /** Id used to locate the target's index in `items`. Not necessarily the id
   * the final scroll target names (e.g. a range target scrolls by its own
   * id within this item). */
  readonly itemId: string;
  /** Checked before every attempt, including the first, and again right
   * before the final scroll. Lets the caller cancel a stale or
   * already-satisfied run without this function knowing why. */
  readonly isStale: () => boolean;
  /** Built once, right before the target is known to exist in `items`. */
  readonly buildTarget: () => CodeViewScrollTarget;
  readonly onScrolled?: () => void;
};

/**
 * Scrolls `viewer` to a target item once it is found in `items`.
 *
 * CodeView recalculates line metrics after expanding a selected unchanged
 * hunk, so this waits two animation frames before attempting the scroll.
 *
 * Returns a cleanup that cancels the pending animation frames; callers must
 * invoke it when the triggering condition changes or the component unmounts.
 */
export function materializeAndScrollTo<T>({
  viewer,
  items,
  itemId,
  isStale,
  buildTarget,
  onScrolled,
}: MaterializeAndScrollOptions<T>): () => void {
  let secondFrame: number | undefined;

  const attempt = (): void => {
    // A newer target superseded this one while a stale frame from this
    // closure was still pending.
    if (isStale()) return;
    if (items.findIndex((item) => item.id === itemId) === -1) return;
    viewer.current?.scrollTo(buildTarget());
    onScrolled?.();
  };

  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(attempt);
  });

  return () => {
    cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
  };
}
