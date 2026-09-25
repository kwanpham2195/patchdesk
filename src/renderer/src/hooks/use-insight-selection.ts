import { useContext, useEffect, useRef, useState } from "react";

import type { InsightRunDialogType } from "../components/insight-run-dialog";
import {
  analysisFindingRowId,
  ReviewWorkbenchFindingNavigationContext,
} from "../components/review-workbench-finding-navigation";
import type { WorkbenchResponse } from "../renderer-contracts";

/** The tab strip's reading order, which is also the order the default landing checks. */
const LANDING_ORDER = [
  "brief",
  "walkthrough",
  "analysis",
] as const satisfies ReadonlyArray<InsightRunDialogType>;

/** Owns which Insight reader is selected and honours a finding focus request once per token. */
export function useInsightSelection(
  initialDetail: InsightRunDialogType | undefined,
  insights: WorkbenchResponse["insights"],
) {
  const findingNavigation = useContext(ReviewWorkbenchFindingNavigationContext);
  // The reader left for the Diff wins, then a saved detail; otherwise land on
  // the first Insight with content so the reader does not open on an empty
  // Generate prompt (#350).
  const [initialInsight] = useState<InsightRunDialogType>(
    () =>
      findingNavigation?.lastInsight ??
      initialDetail ??
      LANDING_ORDER.find((type) => insights[type]?.retained !== undefined) ??
      "brief",
  );
  const [selectedInsight, setSelectedInsight] =
    useState<InsightRunDialogType>(initialInsight);
  const rememberInsight = findingNavigation?.rememberInsight;
  useEffect(() => {
    rememberInsight?.(selectedInsight);
  }, [rememberInsight, selectedInsight]);
  const findingFocusRequest = findingNavigation?.findingFocusRequest;
  const handledFindingFocusToken = useRef<number>(0);
  // A Diff card's "Open in Analysis" lands here: select the Analysis reader,
  // then focus the finding's row once that reader is on screen. Each request
  // is honoured once, by token, so the reader can leave Analysis afterwards.
  useEffect(() => {
    if (
      findingFocusRequest === undefined ||
      findingFocusRequest.token === handledFindingFocusToken.current
    )
      return;
    if (selectedInsight !== "analysis") {
      setSelectedInsight("analysis");
      return;
    }
    handledFindingFocusToken.current = findingFocusRequest.token;
    const row = document.getElementById(
      analysisFindingRowId(findingFocusRequest.findingId),
    );
    if (row === null) return;
    row.scrollIntoView?.({ block: "center" });
    row.focus({ preventScroll: true });
  }, [findingFocusRequest, selectedInsight]);

  return {
    initialInsight,
    selectedInsight,
    setSelectedInsight,
    openFindingInDiff: findingNavigation?.openFindingInDiff,
    openFileInDiff: findingNavigation?.openFileInDiff,
  };
}
