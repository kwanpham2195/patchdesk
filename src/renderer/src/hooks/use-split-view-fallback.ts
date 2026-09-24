import {
  createContext,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";

import type { ReviewViewPreferences } from "@/review-view-preferences";

// Each split side spends ~49px on its line-number gutter and change bar, and 13px mono is 7.8px a character, so 840px leaves two ~48-character code columns; below that most code lines are clipped on both sides.
export const SPLIT_VIEW_MIN_PANE_WIDTH = 840;

/** An unmeasured pane (zero width, e.g. a hidden tab) keeps the saved style. */
export function isPaneTooNarrowForSplit(paneWidth: number): boolean {
  return paneWidth > 0 && paneWidth < SPLIT_VIEW_MIN_PANE_WIDTH;
}

/** The reviewer's saved diff style while the pane is too narrow for split; undefined while it fits. */
export const SplitViewFallbackContext = createContext<
  ReviewViewPreferences["diffStyle"] | undefined
>(undefined);

type SplitViewFallback = {
  /** The preferences to draw with: unified in place of a saved split while the pane is narrow. */
  readonly preferences: ReviewViewPreferences;
  readonly savedStyleWhileNarrow:
    | ReviewViewPreferences["diffStyle"]
    | undefined;
};

/**
 * Draws unified while `pane` is too narrow for split, without touching the
 * saved preference, and returns to the saved style when the pane widens.
 */
export function useSplitViewFallback(
  pane: RefObject<HTMLElement | null>,
  preferences: ReviewViewPreferences,
): SplitViewFallback {
  const [narrowPane, setNarrowPane] = useState(false);
  useLayoutEffect(() => {
    const element = pane.current;
    if (element === null) return;
    const measure = (): void =>
      setNarrowPane(
        isPaneTooNarrowForSplit(element.getBoundingClientRect().width),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [pane]);
  const rendered = useMemo(
    () =>
      narrowPane && preferences.diffStyle === "split"
        ? { ...preferences, diffStyle: "unified" as const }
        : preferences,
    [narrowPane, preferences],
  );
  return {
    preferences: rendered,
    savedStyleWhileNarrow: narrowPane ? preferences.diffStyle : undefined,
  };
}
