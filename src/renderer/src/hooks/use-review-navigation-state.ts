import { useEffect, useRef } from "react";

import type { ReviewWorkbenchActions } from "../components/review-workbench-contracts";
import { useLatestCommitted } from "./use-latest-committed";

type ReviewNavigationState = Parameters<
  ReviewWorkbenchActions["reportNavigationState"]
>[0];

/**
 * Reports the Review's leave guard on each change: `write_pending` while a
 * GitHub write is in flight, `dirty_draft` while a Finish review summary is
 * kept, else `clear`. The app starts clear, so a mount reports only a guard.
 */
export function useReviewNavigationState({
  writePending,
  draftKept,
  report,
}: {
  readonly writePending: boolean;
  readonly draftKept: boolean;
  readonly report: ReviewWorkbenchActions["reportNavigationState"];
}): void {
  const state: ReviewNavigationState = writePending
    ? "write_pending"
    : draftKept
      ? "dirty_draft"
      : "clear";
  const reported = useRef<ReviewNavigationState>("clear");
  const latestReport = useLatestCommitted(report);
  useEffect(() => {
    if (reported.current === state) return;
    reported.current = state;
    latestReport.current(state);
  }, [latestReport, state]);
  // A kept summary dies with the Review. An exit the leave dialog does not
  // guard, such as a workspace switch, must not leave navigation blocked.
  useEffect(
    () => () => {
      if (reported.current !== "dirty_draft") return;
      reported.current = "clear";
      latestReport.current("clear");
    },
    [latestReport],
  );
}
