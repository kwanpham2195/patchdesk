import { useCallback, useEffect, useRef, useState } from "react";
import { useLatestCommitted } from "@/hooks/use-latest-committed";

const DEFAULT_SETTLE_DELAY_MS = 200;

/**
 * Holds a value back from its consumer while a scroll is in flight, only
 * catching it up once scrolling has been quiet for `settleDelayMs`.
 *
 * Why this exists: CodeView (`@pierre/diffs`) treats any change to an
 * item's `version` or `fileDiff` as a layout mutation, and a layout
 * mutation mid-scroll is unsafe there. `CodeView.js:1233` computes
 * `fitPerfectly = !computeScrollCorrection && (...)`, and
 * `computeScrollCorrection` is forced true on every frame where
 * `layoutDirtyIndex != null` (`CodeView.js:1214-1219`) -- so a layout-dirty
 * frame can never take the `fitPerfectly` path, the one branch built to
 * safely recenter the render window after a large scroll jump. The
 * fallback, `getScrollAnchor` (`CodeView.js:1442-1471`), only searches the
 * *previous* frame's rendered window and returns `undefined` once a fast
 * scroll has outrun it. This has been observed to produce a frame where
 * the diff viewport goes fully blank. The exact arithmetic that empties the
 * viewport was not proven by static reading of CodeView.js -- a
 * main-thread/compositor race is also plausible -- but the trigger is
 * certain: hydration mutating CodeView's layout while a fast scroll is in
 * flight. Consumers here should read the caught-up value, not the live one,
 * for anything that flows into CodeView's item list.
 */
export type ScrollSettledValue<T> = {
  readonly settledValue: T;
  readonly notifyScroll: () => void;
};

export function useScrollSettledValue<T>(
  liveValue: T,
  settleDelayMs: number = DEFAULT_SETTLE_DELAY_MS,
): ScrollSettledValue<T> {
  const [settledValue, setSettledValue] = useState(liveValue);
  // A ref, not state: `notifyScroll` runs on every scroll event, and a
  // setState there would re-render the whole diff view on every pixel of
  // scroll -- the exact cost this hook exists to avoid.
  const scrollingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestLiveValue = useLatestCommitted(liveValue);

  useEffect(() => {
    // Covers mount (nothing is scrolling yet) and any live change that
    // lands between scrolls -- both are safe to apply right away since
    // CodeView isn't mid-fling.
    if (!scrollingRef.current) setSettledValue(liveValue);
    // While a scroll is in flight this intentionally does nothing further;
    // the pending timer below reads `latestLiveValue` fresh when it fires,
    // so no update landed during the scroll is ever dropped.
  }, [liveValue]);

  const notifyScroll = useCallback(() => {
    scrollingRef.current = true;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      scrollingRef.current = false;
      setSettledValue(latestLiveValue.current);
    }, settleDelayMs);
  }, [latestLiveValue, settleDelayMs]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { settledValue, notifyScroll };
}
