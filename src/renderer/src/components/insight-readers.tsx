import type { ParsedPatchFile } from "../../../domain/patch";
import { BriefReader } from "./brief-reader";
import { renderAnalysisReviewSummary } from "../analysis-review-summary";
import { AnalysisReader } from "./analysis-reader";
import { projectReadOnlyConversationAnnotations } from "../inline-conversation-mapping";
import { WalkthroughProgressReader } from "./walkthrough-progress-reader";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { InsightRunDialogType } from "./insight-run-dialog";
import type { AnalysisVerificationControls } from "../hooks/use-analysis-verification";

type InsightReaderBuilderInput = {
  readonly workbench: WorkbenchResponse;
  /** `workbench.fullPatch` already parsed, so a render does not reparse megabytes of diff text. */
  readonly patchFiles: ReadonlyArray<ParsedPatchFile>;
  readonly selectedInsight: InsightRunDialogType;
  readonly profileId: string;
  readonly reviewId: string;
  readonly onFinishWithAnalysisSummary?: (summary: string) => void;
  readonly addFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly dismissFinding: (
    finding: AnalysisFinding,
    reason: string,
  ) => Promise<void>;
  readonly analysisVerification: AnalysisVerificationControls;
  readonly walkthroughFocused: boolean;
  readonly setWalkthroughFocused: (focused: boolean) => void;
  /** Opens the run dialog from the Brief's own Provenance card. */
  readonly onRegenerateBrief: () => void;
  /** Drives the Brief "Start here" card's Walkthrough link: open the one that exists, or run one. */
  readonly onOpenWalkthrough: () => void;
  readonly runEnabled: boolean;
  /** Opens the Diff tab at a mapped finding's lines; absent outside the workbench. */
  readonly onOpenFindingInDiff?: (finding: AnalysisFinding) => void;
};
/**
 * Says whether a retained Walkthrough can show inline discussion, and if not,
 * whether regenerating ("stale") or refreshing ("loading") is what can help.
 */
export function walkthroughDiscussionState(
  workbench: WorkbenchResponse,
  snapshot: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly headSha: string;
    readonly patchHash: string;
  },
): "available" | "stale" | "loading" {
  const walkthrough = workbench.insights.walkthrough;
  if (
    walkthrough.status !== "current" ||
    walkthrough.artifactStatus !== "verified" ||
    snapshot.profileId !== workbench.session.key.profileId ||
    snapshot.sessionId !== workbench.session.id ||
    snapshot.headSha !== workbench.revision.reviewedHeadSha ||
    // A patch hash that has not loaded yet is a loading case, not a mismatch.
    (workbench.revision.patchHash !== undefined &&
      snapshot.patchHash !== workbench.revision.patchHash)
  )
    return "stale";
  if (
    workbench.revision.freshness !== "fresh" ||
    workbench.fullPatch === undefined ||
    workbench.revision.patchHash === undefined ||
    workbench.conversation.inline?.complete !== true
  )
    return "loading";
  return "available";
}

export function buildInsightReaders({
  workbench,
  patchFiles,
  selectedInsight,
  profileId,
  reviewId,
  onFinishWithAnalysisSummary,
  addFinding,
  dismissFinding,
  analysisVerification,
  onOpenFindingInDiff,
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
    fileCount: workbench.pullRequest?.changedFileCount ?? patchFiles.length,
    additions: workbench.pullRequest?.additions ?? 0,
    deletions: workbench.pullRequest?.deletions ?? 0,
    changedFiles: patchFiles.map((file) => ({
      path: file.newPath,
      additions: file.additions,
      deletions: file.deletions,
    })),
  };
  const analysisResult = workbench.insights.analysis.retained?.value;
  const pullRequest = workbench.pullRequest;
  const fixPromptContext =
    pullRequest === undefined
      ? undefined
      : {
          owner: pullRequest.ref.owner,
          repo: pullRequest.ref.repo,
          number: pullRequest.ref.number,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
        };

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
        needsReplyFindingIds={
          new Set(
            Object.entries(
              workbench.analysisReviewActions?.findings ?? {},
            ).flatMap(([id, status]) =>
              status.state === "published" && status.needsReply ? [id] : [],
            ),
          )
        }
        {...(workbench.insights.analysis.status === "current" &&
        workbench.fullPatch !== undefined
          ? { evidencePatch: workbench.fullPatch }
          : {})}
        {...(workbench.insights.analysis.status === "current" &&
        onOpenFindingInDiff !== undefined
          ? { onOpenFindingInDiff }
          : {})}
        fixPromptContext={fixPromptContext}
        verification={analysisVerification}
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
          ? { onAddFinding: addFinding }
          : {})}
        {...(workbench.insights.analysis.status === "current" &&
        // The server refuses a dismissal on a merged or closed Review.
        workbench.review.status === "open"
          ? { onDismissFinding: dismissFinding }
          : {})}
      />
    ) : null;
  const walkthroughRetained = workbench.insights.walkthrough.retained;
  const walkthroughDiscussion =
    walkthroughRetained === undefined
      ? undefined
      : walkthroughDiscussionState(
          workbench,
          walkthroughRetained.value.snapshot,
        );
  const walkthroughAnnotations =
    walkthroughDiscussion === "available" && workbench.fullPatch !== undefined
      ? projectReadOnlyConversationAnnotations(
          patchFiles,
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
        {...(walkthroughDiscussion === undefined ||
        walkthroughDiscussion === "available"
          ? {}
          : { discussionUnavailable: walkthroughDiscussion })}
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
        {...(workbench.review.status === "open"
          ? { onRegenerate: onRegenerateBrief }
          : {})}
        regenerateDisabled={!runEnabled}
        walkthroughStatus={workbench.insights.walkthrough.status}
        onOpenWalkthrough={onOpenWalkthrough}
      />
    ) : null;
  return retainedAnalysis ?? retainedWalkthrough ?? retainedBrief;
}
