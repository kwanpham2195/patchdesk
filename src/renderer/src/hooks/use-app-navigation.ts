import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { WorkbenchPayload } from "../renderer-models";
import type { AppDestination } from "../routes";
import { destinationKey, parseDestination } from "../routes";

export type NavigationState = "clear" | "dirty_draft" | "write_pending";

/**
 * The renderer's route state: where the app is, what is holding it there, and
 * the loaded Review the workbench route renders.
 *
 * `workbench` lives here rather than in `use-review-workbench-route` because
 * navigating away clears it — `performNavigation` drops the payload for any
 * destination that is not the workbench — so the route state and the payload
 * are one piece of state, not two.
 */
export type AppNavigation = {
  readonly destination: AppDestination;
  readonly setDestination: Dispatch<SetStateAction<AppDestination>>;
  readonly workbench: WorkbenchPayload | undefined;
  readonly setWorkbench: Dispatch<SetStateAction<WorkbenchPayload | undefined>>;
  readonly navigationState: NavigationState;
  readonly setNavigationState: Dispatch<SetStateAction<NavigationState>>;
  readonly pendingDestination: AppDestination | undefined;
  readonly setPendingDestination: Dispatch<
    SetStateAction<AppDestination | undefined>
  >;
  /** Navigates without asking, and forgets the Review the workbench held. */
  readonly performNavigation: (next: AppDestination) => void;
  /** Navigates, or parks the destination behind the leave-confirmation. */
  readonly navigate: (next: AppDestination) => void;
};

export function useAppNavigation(): AppNavigation {
  const [destination, setDestination] = useState<AppDestination>(() =>
    parseDestination(
      globalThis.window === undefined
        ? null
        : window.localStorage.getItem("patchdesk.destination"),
    ),
  );
  const [workbench, setWorkbench] = useState<WorkbenchPayload | undefined>();
  const [navigationState, setNavigationState] =
    useState<NavigationState>("clear");
  const [pendingDestination, setPendingDestination] =
    useState<AppDestination>();

  const performNavigation = useCallback((next: AppDestination): void => {
    if (next.kind !== "workbench") setWorkbench(undefined);
    setDestination(next);
    window.localStorage.setItem("patchdesk.destination", destinationKey(next));
  }, []);
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
    setDestination,
    workbench,
    setWorkbench,
    navigationState,
    setNavigationState,
    pendingDestination,
    setPendingDestination,
    performNavigation,
    navigate,
  };
}
