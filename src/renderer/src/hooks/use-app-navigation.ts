import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { WorkbenchPayload } from "../renderer-models";
import type { AppDestination } from "../routes";
import { destinationKey, parseDestination } from "../routes";
import { useLatestCommitted } from "./use-latest-committed";
import { newestConversationTimestamp } from "../../../domain/conversation-entry-timestamp";
import { definedProps } from "../../../domain/defined-props";

export type NavigationState = "clear" | "dirty_draft" | "write_pending";

/** The Review the maintainer is navigating away from, and what it showed them. */
export type LeftWorkbench = {
  readonly profileId: string;
  readonly reviewId: string;
  readonly headSha: string;
  /** GitHub's time on the newest Conversation entry shown; absent when none was dated. */
  readonly seenThrough?: string;
};

/**
 * The renderer's route state: where the app is, what is holding it there, and
 * the loaded Review the workbench route renders.
 *
 * `workbench` lives here rather than in `use-review-workbench-route` because
 * navigating away clears it — `performNavigation` keeps the payload only for a
 * workbench destination naming the Review it already holds, and drops it
 * otherwise — so the route state and the payload are one piece of state, not
 * two.
 */
export type AppNavigation = {
  readonly destination: AppDestination;
  readonly workbench: WorkbenchPayload | undefined;
  readonly setWorkbench: Dispatch<SetStateAction<WorkbenchPayload | undefined>>;
  readonly navigationState: NavigationState;
  readonly setNavigationState: Dispatch<SetStateAction<NavigationState>>;
  /**
   * Whether the app is still on the destination restored from localStorage at
   * mount, with no navigation since. Only that first destination is a boot
   * restore, so only it may fail quietly when its Review is gone.
   */
  readonly bootRestoredDestination: boolean;
  readonly pendingDestination: AppDestination | undefined;
  readonly setPendingDestination: Dispatch<
    SetStateAction<AppDestination | undefined>
  >;
  /** Navigates without asking, forgetting and reporting a held Review the route leaves. */
  readonly performNavigation: (next: AppDestination) => void;
  /** Navigates, or parks the destination behind the leave-confirmation. */
  readonly navigate: (next: AppDestination) => void;
};

/**
 * `onLeaveWorkbench` hears only a Review that was loaded on screen: a workbench
 * destination still loading showed the maintainer nothing to have looked at.
 */
export function useAppNavigation(
  onLeaveWorkbench: (left: LeftWorkbench) => void,
): AppNavigation {
  const [destination, setDestination] = useState<AppDestination>(() =>
    parseDestination(
      globalThis.window === undefined
        ? null
        : window.localStorage.getItem("patchdesk.destination"),
    ),
  );
  const [workbench, setWorkbench] = useState<WorkbenchPayload | undefined>();
  const [bootRestoredDestination, setBootRestoredDestination] = useState(true);
  const [navigationState, setNavigationState] =
    useState<NavigationState>("clear");
  const [pendingDestination, setPendingDestination] =
    useState<AppDestination>();

  const committedDestination = useLatestCommitted(destination);
  const committedWorkbench = useLatestCommitted(workbench);
  const committedOnLeave = useLatestCommitted(onLeaveWorkbench);

  const performNavigation = useCallback(
    (next: AppDestination): void => {
      const left = committedDestination.current;
      const shown = committedWorkbench.current;
      if (
        left.kind === "workbench" &&
        shown?.review.id === left.reviewId &&
        destinationKey(next) !== destinationKey(left)
      )
        committedOnLeave.current({
          profileId: shown.session.key.profileId,
          reviewId: shown.review.id,
          headSha: shown.revision.reviewedHeadSha,
          ...definedProps({
            seenThrough: newestConversationTimestamp(
              shown.conversation.entries,
            ),
          }),
        });
      setWorkbench((held) => {
        if (next.kind !== "workbench" || held === undefined) return undefined;
        // The same id `openWorkbench` in `app.tsx` routes by, so a payload the
        // route was built from is recognized as the one the route still names.
        return held.review.id === next.reviewId ? held : undefined;
      });
      setDestination(next);
      setBootRestoredDestination(false);
      window.localStorage.setItem(
        "patchdesk.destination",
        destinationKey(next),
      );
    },
    [committedDestination, committedWorkbench, committedOnLeave],
  );
  const navigate = useCallback(
    (next: AppDestination): void => {
      if (destinationKey(next) === destinationKey(destination)) return;
      if (navigationState !== "clear") {
        setPendingDestination(next);
        return;
      }
      performNavigation(next);
    },
    [destination, navigationState, performNavigation],
  );
  return {
    destination,
    workbench,
    setWorkbench,
    navigationState,
    setNavigationState,
    bootRestoredDestination,
    pendingDestination,
    setPendingDestination,
    performNavigation,
    navigate,
  };
}
