import { createContext } from "react";

import type { MappedFinding } from "./review-workbench-annotations";

/** One request to land the Analysis reader on a finding row; `token` makes repeats distinct. */
export type FindingFocusRequest = {
  readonly findingId: string;
  readonly token: number;
};

/** Cross-tab finding navigation the workbench offers the Insights slot it hosts. */
export type ReviewWorkbenchFindingNavigation = {
  /** Switches to the Diff tab with the finding's lines selected. */
  readonly openFindingInDiff: (finding: MappedFinding) => void;
  /** The latest Diff-to-Analysis request, if any. */
  readonly findingFocusRequest: FindingFocusRequest | undefined;
};

/** The DOM id of one finding row in the Analysis reader. */
export function analysisFindingRowId(findingId: string): string {
  return `finding-${findingId}`;
}

// The Insights slot is a ReactNode built by the flow, so the workbench hands
// it navigation through context rather than props.
export const ReviewWorkbenchFindingNavigationContext = createContext<
  ReviewWorkbenchFindingNavigation | undefined
>(undefined);
