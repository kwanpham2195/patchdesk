import { useState, useSyncExternalStore } from "react";

import {
  loadVisitedPullRequestsCollapsed,
  saveVisitedPullRequestsCollapsed,
} from "@/visited-pull-requests-preferences";

/** Matches Tailwind's `max-sm` (below 640 CSS px), where the titlebar collapses to icons. */
const NARROW_WINDOW_QUERY = "(max-width: 639px)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia?.(NARROW_WINDOW_QUERY);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

function narrowWindow(): boolean {
  return window.matchMedia?.(NARROW_WINDOW_QUERY).matches ?? false;
}

/**
 * Whether the Visited pull requests column shows. Wide, it follows the saved
 * collapse choice. Narrow, which includes a window zoomed in far enough, it is
 * closed whatever the choice says, because beside the main pane it would leave
 * the pane a sliver. The toggle then opens it over the pane for one
 * destination and one narrow stretch; that is not saved, so widening the window
 * restores the saved choice. Absent `matchMedia` (jsdom) reads as wide.
 */
export function useVisitedColumn(destinationKey: string) {
  const narrow = useSyncExternalStore(subscribe, narrowWindow, () => false);
  const [collapsed, setCollapsed] = useState(loadVisitedPullRequestsCollapsed);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [opened, setOpened] = useState(0);
  const [reset, setReset] = useState({ narrow, destinationKey });
  if (reset.narrow !== narrow || reset.destinationKey !== destinationKey) {
    setReset({ narrow, destinationKey });
    setNarrowOpen(false);
  }
  const shown = narrow ? narrowOpen : !collapsed;
  const toggle = (): void => {
    if (!shown) setOpened((count) => count + 1);
    if (narrow) {
      setNarrowOpen(!narrowOpen);
      return;
    }
    setCollapsed(shown);
    saveVisitedPullRequestsCollapsed(shown);
  };
  return { narrow, shown, opened, toggle };
}
