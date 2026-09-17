import { useEffect, useRef, useState } from "react";

import {
  parsePullRequestRef,
  type PullRequestRef,
} from "../../../domain/pull-request";
import type { ReviewWorkbenchInitialState } from "../components/review-workbench-contracts";
import { destinationKey, type AppDestination } from "../routes";
import type { NavigationState } from "./use-app-navigation";
import { useLatestCommitted } from "./use-latest-committed";

/**
 * The position a clicked Insight notification asks its Review workbench to
 * mount with. `generation` changes on every click, so keying the workbench on
 * it remounts a Review that is already on screen.
 */
export type NotificationWorkbenchFocus = {
  readonly reviewId: string;
  readonly state: ReviewWorkbenchInitialState;
  readonly generation: number;
};

/**
 * Routes a clicked desktop notification to its Review through `navigate`, so
 * an unsaved draft or a pending write still holds the maintainer in place.
 * An Insight click also returns the workbench focus to mount with, but only
 * when the click actually moves the screen: a parked navigation or a held
 * Review leaves nothing behind for a later open. A watched pull request
 * click goes to `openPullRequest`, the palette's open path.
 */
export function useDesktopNotificationClicks({
  enabled,
  destination,
  navigationState,
  navigate,
  openPullRequest,
}: {
  readonly enabled: boolean;
  readonly destination: AppDestination;
  readonly navigationState: NavigationState;
  readonly navigate: (next: AppDestination) => void;
  readonly openPullRequest: (ref: PullRequestRef) => void;
}): NotificationWorkbenchFocus | undefined {
  const [focus, setFocus] = useState<NotificationWorkbenchFocus>();
  const generation = useRef(0);
  const latestDestination = useLatestCommitted(destination);
  const latestNavigationState = useLatestCommitted(navigationState);

  // One-shot: moving to any other screen forgets it, so the Review's next open restores its saved position.
  const [seenDestination, setSeenDestination] = useState(() =>
    destinationKey(destination),
  );
  if (seenDestination !== destinationKey(destination)) {
    setSeenDestination(destinationKey(destination));
    if (
      focus !== undefined &&
      destinationKey(destination) !==
        destinationKey({ kind: "workbench", reviewId: focus.reviewId })
    )
      setFocus(undefined);
  }

  useEffect(() => {
    if (!enabled || window.patchdesk?.onNotificationClick === undefined) return;
    return window.patchdesk.onNotificationClick((click) => {
      if (click.kind === "pullRequest") {
        const ref = parsePullRequestRef(click.pullRequest);
        if (ref._tag === "ok") openPullRequest(ref.value);
        return;
      }
      const onScreen =
        destinationKey(latestDestination.current) ===
        destinationKey({ kind: "workbench", reviewId: click.reviewId });
      if (
        click.insightType !== undefined &&
        latestNavigationState.current === "clear"
      ) {
        generation.current += 1;
        setFocus({
          reviewId: click.reviewId,
          state:
            click.insightType === "brief"
              ? { activeTab: "insights" }
              : { activeTab: "insights", insightDetail: click.insightType },
          generation: generation.current,
        });
      }
      if (!onScreen) navigate({ kind: "workbench", reviewId: click.reviewId });
    });
  }, [
    enabled,
    latestDestination,
    latestNavigationState,
    navigate,
    openPullRequest,
  ]);

  return focus;
}
