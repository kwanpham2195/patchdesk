import { parseUnifiedPatch } from "../../../domain/patch";
import { BriefReader } from "./brief-reader";
import { renderAnalysisReviewSummary } from "../analysis-review-summary";
import { AnalysisReader } from "./analysis-reader";
import { projectReadOnlyConversationAnnotations } from "../inline-conversation-mapping";
import { WalkthroughProgressReader } from "./walkthrough-progress-reader";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { InsightSelection } from "./insight-panels";

type InsightReaderBuilderInput = {
  readonly workbench: WorkbenchResponse;
  readonly selectedInsight: InsightSelection;
  readonly profileId: string;
  readonly reviewId: string;
  readonly onFinishWithAnalysisSummary?: (summary: string) => void;
  readonly addFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly dismissFinding: (
    finding: AnalysisFinding,
    reason: string,
  ) => Promise<void>;
  readonly walkthroughFocused: boolean;
  readonly setWalkthroughFocused: React.Dispatch<React.SetStateAction<boolean>>;
  /** Opens the run dialog from the Brief's own Provenance card. */
  readonly onRegenerateBrief: () => void;
  /** Drives the Brief "Start here" card's Walkthrough link: open the one that exists, or run one. */
  readonly onOpenWalkthrough: () => void;
  readonly runEnabled: boolean;
};
export function buildInsightReaders({
  workbench,
  selectedInsight,
  profileId,
  reviewId,
  onFinishWithAnalysisSummary,
  addFinding,
  dismissFinding,
  walkthroughFocused,
  setWalkthroughFocused,
  onRegenerateBrief,
  onOpenWalkthrough,
  runEnabled,
}: InsightReaderBuilderInput): React.ReactNode {
  const analysisSummaryScope = {
    baseShort: (workbench.pullRequest?.baseSha ?? "unknown").slice(0, 7),
    headShort: workbench.session.key.headSha.slice(0, 7),
    commitCount: workbench.commits.length,
    fileCount:
      workbench.pullRequest?.changedFileCount ??
      (workbench.fullPatch === undefined
        ? 0
        : parseUnifiedPatch(workbench.fullPatch).length),
    additions: workbench.pullRequest?.additions ?? 0,
    deletions: workbench.pullRequest?.deletions ?? 0,
    changedFiles:
      workbench.fullPatch === undefined
        ? []
        : parseUnifiedPatch(workbench.fullPatch).map((file) => ({
            path: file.newPath,
            additions: file.additions,
            deletions: file.deletions,
          })),
  };
  const analysisResult = workbench.insights.analysis.retained?.value;

  const retainedAnalysis =
    selectedInsight === "analysis" &&
    workbench.insights.analysis.retained !== undefined ? (
      <AnalysisReader
        result={workbench.insights.analysis.retained.value}
        checkStatus={workbench.checks.overall}
        findingStatuses={Object.fromEntries(
          Object.entries(workbench.analysisReviewActions?.findings ?? {}).map(
            ([id, status]) => [id, status.state],
          ),
        )}
        {...(workbench.insights.analysis.status === "current" &&
        workbench.fullPatch !== undefined
          ? { evidencePatch: workbench.fullPatch }
          : {})}
        canFinishWithAnalysisSummary={
          workbench.analysisReviewActions?.canFinishWithAnalysisSummary ?? false
        }
        {...(workbench.analysisReviewActions?.canFinishWithAnalysisSummary ===
          true &&
        analysisResult !== undefined &&
        onFinishWithAnalysisSummary !== undefined
          ? {
              onFinishWithAnalysisSummary: () =>
                onFinishWithAnalysisSummary(
                  renderAnalysisReviewSummary({
                    result: analysisResult,
                    scope: analysisSummaryScope,
                  }),
                ),
            }
          : {})}
        {...(workbench.insights.analysis.status === "current" &&
        addFinding !== undefined
          ? { onAddFinding: addFinding, onDismissFinding: dismissFinding }
          : workbench.insights.analysis.status === "current"
            ? { onDismissFinding: dismissFinding }
            : {})}
      />
    ) : null;
  const walkthroughRetained = workbench.insights.walkthrough.retained;
  const walkthroughDiscussionAvailable =
    walkthroughRetained !== undefined &&
    workbench.insights.walkthrough.status === "current" &&
    workbench.insights.walkthrough.artifactStatus === "verified" &&
    workbench.revision.freshness === "fresh" &&
    workbench.fullPatch !== undefined &&
    workbench.revision.patchHash !== undefined &&
    workbench.conversation.inline?.complete === true &&
    walkthroughRetained.value.snapshot.profileId ===
      workbench.session.key.profileId &&
    walkthroughRetained.value.snapshot.sessionId === workbench.session.id &&
    walkthroughRetained.value.snapshot.headSha ===
      workbench.revision.reviewedHeadSha &&
    walkthroughRetained.value.snapshot.patchHash ===
      workbench.revision.patchHash;
  const walkthroughAnnotations =
    walkthroughDiscussionAvailable && workbench.fullPatch !== undefined
      ? projectReadOnlyConversationAnnotations(
          parseUnifiedPatch(workbench.fullPatch),
          workbench.conversation.inline?.threads ?? [],
        )
      : undefined;
  const retainedWalkthrough =
    selectedInsight === "walkthrough" &&
    workbench.insights.walkthrough.retained !== undefined ? (
      <WalkthroughProgressReader
        key={JSON.stringify({
          sessionId: workbench.session.id,
          runId: workbench.insights.walkthrough.retained.runId,
          headSha: workbench.revision.reviewedHeadSha,
          progress: workbench.insights.walkthrough.progress,
        })}
        walkthrough={workbench.insights.walkthrough.retained.value}
        initialProgress={workbench.insights.walkthrough.progress}
        profileId={profileId}
        reviewId={reviewId}
        runId={workbench.insights.walkthrough.retained.runId}
        {...(workbench.insights.walkthrough.status === "current" &&
        workbench.fullPatch !== undefined
          ? { rawPatch: workbench.fullPatch }
          : {})}
        {...(walkthroughAnnotations === undefined
          ? {}
          : { annotations: walkthroughAnnotations })}
        {...(walkthroughDiscussionAvailable
          ? {}
          : { discussionUnavailable: true })}
        focused={walkthroughFocused}
        onFocusedChange={setWalkthroughFocused}
      />
    ) : null;
  const briefRetained = workbench.insights.brief?.retained;
  const retainedBrief =
    selectedInsight === "brief" && briefRetained !== undefined ? (
      <BriefReader
        retained={briefRetained}
        {...(workbench.scope === undefined ? {} : { scope: workbench.scope })}
        onRegenerate={onRegenerateBrief}
        regenerateDisabled={!runEnabled}
        walkthroughStatus={workbench.insights.walkthrough.status}
        onOpenWalkthrough={onOpenWalkthrough}
      />
    ) : null;
  return retainedAnalysis ?? retainedWalkthrough ?? retainedBrief;
}
