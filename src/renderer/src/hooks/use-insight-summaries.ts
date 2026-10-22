import type { GuideSummary } from "#src/domain/guide-progress";
import type { WalkthroughSummary } from "#src/domain/walkthrough-progress";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { InsightRunDialogType } from "#src/renderer/src/components/insight-run-dialog";
import type { InsightRunController } from "./use-insight-run";
import { useGuideSummary, guideSummaryStatus } from "./use-guide-summary";
import {
  useWalkthroughSummary,
  walkthroughSummaryStatus,
  walkthroughRevisionMatches,
} from "./use-walkthrough-summary";
import { publishedGuideRevisionMatches } from "#src/renderer/src/components/guide-review-controls";
import { NOT_GENERATED_BRIEF } from "#src/renderer/src/brief-contracts";
type SelectedProjection = NonNullable<
  WorkbenchResponse["insights"][Exclude<InsightRunDialogType, "guide">]
>;

type InsightSummaries = {
  readonly guideSummary: ReturnType<typeof useGuideSummary>;
  readonly walkthroughSummary: ReturnType<typeof useWalkthroughSummary>;
  readonly guideSnapshot: GuideSummary | undefined;
  readonly readyGuide: Extract<GuideSummary, { _tag: "ready" }> | undefined;
  readonly readyWalkthrough:
    | Extract<WalkthroughSummary, { _tag: "ready" }>
    | undefined;
  readonly walkthroughRun: WalkthroughSummary["run"];
  readonly walkthroughCanRegenerate: boolean;
  readonly guideStatus: ReturnType<typeof guideSummaryStatus>;
  readonly walkthroughStatus: ReturnType<typeof walkthroughSummaryStatus>;
  readonly selectedProjection: SelectedProjection | undefined;
  readonly selectedRetained:
    | SelectedProjection["retained"]
    | Extract<WalkthroughSummary, { _tag: "ready" }>;
  readonly selectedIsOutdated: boolean;
  readonly analysisFirstRunActive: boolean;
  readonly walkthroughTitle: string | undefined;
};

/** Each paged reader's controls and navigation select the same published summary. */
export function useInsightSummaries(
  workbench: WorkbenchResponse,
  runs: Readonly<Record<InsightRunDialogType, InsightRunController>>,
  selected: InsightRunDialogType,
): InsightSummaries {
  const guideSummary = useGuideSummary(
    workbench,
    runs.guide,
    selected === "guide",
  );
  const walkthroughSummary = useWalkthroughSummary(
    workbench,
    runs.walkthrough,
    selected === "walkthrough",
  );
  const guideSnapshot =
    guideSummary.state.status === "loaded"
      ? guideSummary.state.summary
      : undefined;
  const walkthroughSnapshot =
    walkthroughSummary.state.status === "loaded"
      ? walkthroughSummary.state.summary
      : undefined;
  const readyGuide =
    guideSnapshot?._tag === "ready" ? guideSnapshot : undefined;
  const readyWalkthrough =
    walkthroughSnapshot?._tag === "ready" ? walkthroughSnapshot : undefined;
  const walkthroughStatus = walkthroughSummaryStatus(
    workbench,
    walkthroughSummary.state,
    runs.walkthrough,
  );
  const selectedProjection =
    selected === "guide"
      ? undefined
      : selected === "walkthrough"
        ? {
            ...workbench.insights.walkthrough,
            status: walkthroughStatus.status,
          }
        : selected === "brief"
          ? (workbench.insights.brief ?? NOT_GENERATED_BRIEF)
          : workbench.insights.analysis;
  const selectedRetained =
    selected === "walkthrough"
      ? readyWalkthrough
      : selectedProjection?.retained;
  const selectedIsOutdated =
    selected === "guide"
      ? readyGuide !== undefined &&
        workbench.revision.patchHash !== undefined &&
        !publishedGuideRevisionMatches(workbench, readyGuide)
      : selected === "walkthrough"
        ? readyWalkthrough !== undefined &&
          !walkthroughRevisionMatches(workbench, readyWalkthrough)
        : selectedProjection?.status === "outdated";
  return {
    guideSummary,
    walkthroughSummary,
    guideSnapshot,
    readyGuide,
    readyWalkthrough,
    selectedProjection,
    selectedRetained,
    selectedIsOutdated,
    analysisFirstRunActive:
      selected === "analysis" &&
      selectedProjection?.status === "running" &&
      selectedProjection.retained === undefined,
    walkthroughTitle:
      selected === "walkthrough" ? readyWalkthrough?.title : undefined,
    walkthroughRun: walkthroughSnapshot?.run ?? null,
    walkthroughCanRegenerate:
      walkthroughSnapshot?._tag === "ready" && walkthroughSnapshot.run === null,
    guideStatus: guideSummaryStatus(workbench, guideSummary.state, runs.guide),
    walkthroughStatus,
  };
}
