import { useContext, useEffect, useRef, useState } from "react";

import type { InsightSelection } from "../components/insight-panels";
import {
  analysisFindingRowId,
  ReviewWorkbenchFindingNavigationContext,
} from "../components/review-workbench-finding-navigation";

/** Owns which Insight reader is selected and honours a finding focus request once per token. */
export function useInsightSelection(
  initialDetail: InsightSelection | undefined,
) {
  // Insights with no saved detail land on Brief: the shape of the change comes
  // before the judgment of it. A saved detail wins, so this only decides the
  // very first open. Brief lands even when none has been generated, showing its
  // Generate control rather than falling through to a ready Insight.
  const [selectedInsight, setSelectedInsight] = useState<InsightSelection>(
    initialDetail ?? "brief",
  );
  const findingNavigation = useContext(ReviewWorkbenchFindingNavigationContext);
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
    selectedInsight,
    setSelectedInsight,
    openFindingInDiff: findingNavigation?.openFindingInDiff,
  };
}
