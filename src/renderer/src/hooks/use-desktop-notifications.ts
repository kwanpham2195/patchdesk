import { useEffect, type RefObject } from "react";

import type { ReviewWorkbenchInitialState } from "../components/review-workbench-contracts";
import type { AppDestination } from "../routes";

/**
 * Routes a clicked desktop notification to its Review. It goes through
 * `navigate`, so an unsaved draft or a pending write still holds the
 * maintainer where they are, exactly as any other navigation does.
 */
export function useDesktopNotificationClicks({
  enabled,
  navigate,
  restoredWorkbenchUi,
}: {
  readonly enabled: boolean;
  readonly navigate: (next: AppDestination) => void;
  /** The one-shot initial position the Review route applies when it next loads that Review. */
  readonly restoredWorkbenchUi: RefObject<
    | { readonly reviewId: string; readonly state: ReviewWorkbenchInitialState }
    | undefined
  >;
}): void {
  useEffect(() => {
    if (!enabled || window.patchdesk?.onNotificationClick === undefined) return;
    return window.patchdesk.onNotificationClick((click) => {
      if (click.insightType !== undefined)
        restoredWorkbenchUi.current = {
          reviewId: click.reviewId,
          state:
            click.insightType === "brief"
              ? { activeTab: "insights" }
              : { activeTab: "insights", insightDetail: click.insightType },
        };
      navigate({ kind: "workbench", reviewId: click.reviewId });
    });
  }, [enabled, navigate, restoredWorkbenchUi]);
}
