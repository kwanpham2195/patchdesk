import { useLayoutEffect, useRef, type RefObject } from "react";

type InsightResult = "analysis" | "brief" | "walkthrough" | "guide";
type InsightResultStatus =
  | "not_generated"
  | "running"
  | "current"
  | "outdated"
  | "failed";

type RetainedRunIds = Readonly<Record<InsightResult, string | undefined>>;

/** Marks only newly completed visible retained Insight results for one-frame entrance motion. */
export function useInsightResultEntrance({
  retainedRunIds,
  selectedInsight,
  selectedProjectionStatus,
}: {
  readonly retainedRunIds: RetainedRunIds;
  readonly selectedInsight: InsightResult;
  readonly selectedProjectionStatus: InsightResultStatus | undefined;
}): RefObject<HTMLDivElement | null> {
  const {
    analysis: analysisRunId,
    brief: briefRunId,
    walkthrough: walkthroughRunId,
    guide: guideRunId,
  } = retainedRunIds;
  const resultRef = useRef<HTMLDivElement | null>(null);
  const observedRunIds = useRef(retainedRunIds);
  const pendingFrame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const observed = observedRunIds.current;
    const selectedRunId =
      selectedInsight === "analysis"
        ? analysisRunId
        : selectedInsight === "brief"
          ? briefRunId
          : selectedInsight === "guide"
            ? guideRunId
            : walkthroughRunId;
    const wrapper = resultRef.current;
    const shouldEnter =
      selectedProjectionStatus === "current" &&
      selectedRunId !== undefined &&
      selectedRunId !== observed[selectedInsight] &&
      wrapper !== null;

    if (shouldEnter) {
      wrapper.setAttribute("data-insight-result-entering", "");
      if (pendingFrame.current !== null)
        window.cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = window.requestAnimationFrame(() => {
        wrapper.removeAttribute("data-insight-result-entering");
        pendingFrame.current = null;
      });
    }

    observedRunIds.current = {
      analysis: analysisRunId,
      brief: briefRunId,
      walkthrough: walkthroughRunId,
      guide: guideRunId,
    };

    return () => {
      if (pendingFrame.current !== null) {
        window.cancelAnimationFrame(pendingFrame.current);
        pendingFrame.current = null;
      }
      wrapper?.removeAttribute("data-insight-result-entering");
    };
  }, [
    analysisRunId,
    briefRunId,
    walkthroughRunId,
    guideRunId,
    selectedInsight,
    selectedProjectionStatus,
  ]);

  return resultRef;
}
