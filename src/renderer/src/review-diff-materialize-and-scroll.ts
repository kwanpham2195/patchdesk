import type { RefObject } from "react";
import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

// Each attempt materializes up to this many more items and waits a frame.
// Bounds the retry chain so a target that never resolves in the viewer (a
// defect in its own right) gives up honestly instead of polling forever.
export const MAX_MATERIALIZE_SCROLL_ATTEMPTS = 120;
// Items materialized per retry attempt. Keeps navigation responsive on huge
// patches by never rendering thousands of items in a single batch.
const MATERIALIZE_CHUNK_SIZE = 128;

export type MaterializeScrollProgress = { attempts: number };

export type MaterializeAndScrollOptions<T> = {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly items: ReadonlyArray<{ readonly id: string }>;
  /** Id used to locate the target's index and check whether it has already
   * materialized. Not necessarily the id the final scroll target names
   * (e.g. a range target scrolls by its own id within this item). */
  readonly itemId: string;
  readonly nextItemIndex: RefObject<number>;
  readonly appendItemsThrough: (lastIndex: number) => void;
  /** Attempt count, owned and persisted by the caller across restarts of
   * whatever triggers this (e.g. an effect keyed on the navigation target). */
  readonly progress: MaterializeScrollProgress;
  readonly maxAttempts?: number;
  /** Checked before every attempt, including the first, and again right
   * before the final scroll. Lets the caller cancel a stale or
   * already-satisfied run without this function knowing why. */
  readonly isStale: () => boolean;
  /** Checked once per attempt after the target's index is known. Lets the
   * caller bail out of materializing entirely under caller-specific
   * conditions (e.g. a controlled preference change already in flight). */
  readonly shouldBail?: (targetIndex: number) => boolean;
  /** Built once, right before the target is known to exist in the viewer. */
  readonly buildTarget: () => CodeViewScrollTarget;
  readonly onScrolled?: () => void;
};

/**
 * Scrolls `viewer` to a target item, materializing items in bounded chunks
 * until the target exists.
 *
 * CodeView recalculates line metrics after expanding a selected unchanged
 * hunk, so the first attempt waits two animation frames before running, and
 * every retry after that waits one more frame for the newly materialized
 * chunk to render.
 *
 * Returns a cleanup that cancels every pending animation frame; callers must
 * invoke it when the triggering condition changes or the component unmounts.
 */
export function materializeAndScrollTo<T>({
  viewer,
  items,
  itemId,
  nextItemIndex,
  appendItemsThrough,
  progress,
  maxAttempts = MAX_MATERIALIZE_SCROLL_ATTEMPTS,
  isStale,
  shouldBail,
  buildTarget,
  onScrolled,
}: MaterializeAndScrollOptions<T>): () => void {
  let secondFrame: number | undefined;
  let continuationFrame: number | undefined;

  const attempt = (): void => {
    // A newer target superseded this one while a stale frame from this
    // closure was still pending.
    if (isStale()) return;
    const targetIndex = items.findIndex((item) => item.id === itemId);
    if (targetIndex === -1) return;
    if (shouldBail?.(targetIndex) === true) return;
    if (viewer.current?.getItem(itemId) === undefined) {
      if (progress.attempts >= maxAttempts) {
        // Give up honestly: the target never materialized in the viewer,
        // so stop polling rather than retry forever.
        return;
      }
      progress.attempts += 1;
      appendItemsThrough(
        Math.min(
          targetIndex,
          nextItemIndex.current + MATERIALIZE_CHUNK_SIZE - 1,
        ),
      );
      continuationFrame = requestAnimationFrame(attempt);
      return;
    }
    viewer.current?.scrollTo(buildTarget());
    onScrolled?.();
  };

  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(attempt);
  });

  return () => {
    cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    if (continuationFrame !== undefined)
      cancelAnimationFrame(continuationFrame);
  };
}
