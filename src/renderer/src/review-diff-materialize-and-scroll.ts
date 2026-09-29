import type { RefObject } from "react";
import type {
  CodeViewLineScrollTarget,
  CodeViewScrollTarget,
} from "@pierre/diffs";
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

/** Frames a line scroll is repeated for while its file's rows measure. */
const LINE_SCROLL_SETTLE_FRAMES = 30;

/** Input on the diff that means the user took the scroll over. */
const USER_SCROLL_EVENTS = [
  "wheel",
  "touchmove",
  "pointerdown",
  "keydown",
] as const;

/**
 * Repeats a line scroll each frame until the target line's row is drawn and
 * the scroll position and content height have held still for two frames,
 * then calls `onSettled`.
 *
 * CodeView resolves a line in a file it has not drawn from estimated row
 * heights, first draws that file as a placeholder, and drops the target once
 * the viewport reaches the estimate. When the real rows measure differently,
 * such as wrapped lines, the line moves and nothing follows it, so a jump
 * into another file can stop short of its line.
 *
 * Wheel, touch, pointer, or key input on the diff stops the repeats at once
 * and still calls `onSettled`, so the loop never re-centers under the user.
 *
 * Returns a cleanup that cancels the pending frame and the input listeners.
 */
export function settleLineScroll<T>({
  viewer,
  isStale,
  target,
  onSettled,
}: {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly isStale: () => boolean;
  readonly target: CodeViewLineScrollTarget;
  readonly onSettled: () => void;
}): () => void {
  let pendingFrame: number | undefined;
  let framesLeft = LINE_SCROLL_SETTLE_FRAMES;
  let previous: { top: number; height: number } | undefined;
  let stillFrames = 0;
  const container = viewer.current?.getInstance()?.getContainerElement();
  const stopListening = (): void => {
    for (const type of USER_SCROLL_EVENTS)
      container?.removeEventListener(type, yieldToUser);
  };
  const cancel = (): void => {
    stopListening();
    if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
    pendingFrame = undefined;
  };
  // The user took the scroll over: stop re-centering under them, report the match where they are.
  function yieldToUser(): void {
    cancel();
    if (!isStale()) onSettled();
  }
  const check = (): void => {
    pendingFrame = undefined;
    const codeView = viewer.current?.getInstance();
    if (isStale() || codeView === undefined) {
      stopListening();
      return;
    }
    const drawn =
      codeView
        .getRenderedItems()
        .find((item) => item.id === target.id)
        ?.element.shadowRoot?.querySelector(
          `[data-line="${target.lineNumber}"]`,
        ) != null;
    const current = {
      top: codeView.getScrollTop(),
      height: codeView.getScrollHeight(),
    };
    stillFrames =
      drawn &&
      previous !== undefined &&
      previous.top === current.top &&
      previous.height === current.height
        ? stillFrames + 1
        : 0;
    if (stillFrames >= 2 || framesLeft === 0) {
      stopListening();
      onSettled();
      return;
    }
    framesLeft -= 1;
    previous = current;
    codeView.scrollTo(target);
    pendingFrame = requestAnimationFrame(check);
  };
  for (const type of USER_SCROLL_EVENTS)
    container?.addEventListener(type, yieldToUser, { passive: true });
  pendingFrame = requestAnimationFrame(check);
  return cancel;
}
