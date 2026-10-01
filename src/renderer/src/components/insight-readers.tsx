import * as v from "valibot";

import type { ChangeScopeBucket } from "../../../domain/change-scope";
import { definedProps } from "../../../domain/defined-props";
import type { ParsedPatchFile } from "../../../domain/patch";
import { BriefReader } from "./brief-reader";
import { renderAnalysisReviewSummary } from "../analysis-review-summary";
import { AnalysisReader, type FindingRestoreOutcome } from "./analysis-reader";
import { projectReadOnlyConversationAnnotations } from "../inline-conversation-mapping";
import { WalkthroughProgressReader } from "./walkthrough-progress-reader";
import { requestJson } from "../api-client";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { AddAllFindingsControls } from "../flows/use-add-all-findings";
import type { LocalApplyControls } from "../flows/use-local-apply";
import type { LocalDraftControls } from "../flows/use-local-drafts";
import type { InsightRunDialogType } from "./insight-run-dialog";
import type { AnalysisVerificationControls } from "../hooks/use-analysis-verification";
import type { WalkthroughProgressControls } from "../hooks/use-walkthrough-progress";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";

type InsightReaderBuilderInput = {
  readonly workbench: WorkbenchResponse;
  /** `workbench.fullPatch` already parsed, so a render does not reparse megabytes of diff text. */
  readonly patchFiles: ReadonlyArray<ParsedPatchFile>;
  readonly selectedInsight: InsightRunDialogType;
  readonly onFinishWithAnalysisSummary?: (summary: string) => void;
  readonly addFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly addAllFindings?: AddAllFindingsControls;
  readonly localApply?: LocalApplyControls;
  readonly localDrafts?: LocalDraftControls;
  /** The workbench's note and comment authoring; absent outside the workbench. */
  readonly walkthroughDiffAuthoring?: WalkthroughDiffAuthoring;
  readonly dismissFinding: (
    finding: AnalysisFinding,
    reason: string,
  ) => Promise<void>;
  readonly restoreFinding: (
    finding: AnalysisFinding,
  ) => Promise<FindingRestoreOutcome>;
  readonly analysisVerification: AnalysisVerificationControls;
  readonly walkthroughProgress: WalkthroughProgressControls;
  readonly walkthroughFocused: boolean;
  readonly setWalkthroughFocused: (focused: boolean) => void;
  /** Opens the run dialog from the Brief's own Provenance card. */
  readonly onRegenerateBrief: () => void;
  readonly runEnabled: boolean;
  /** Opens the Diff tab at a mapped finding's lines; absent outside the workbench. */
  readonly onOpenFindingInDiff?: (finding: AnalysisFinding) => void;
  /** Opens one file in the full Review diff; absent outside the workbench. */
  readonly onOpenFileInDiff?: (path: string) => void;
  /** Opens the full Review diff filtered to one Scope bucket; absent outside the workbench. */
  readonly onOpenScopeBucketInDiff?: (bucket: ChangeScopeBucket) => void;
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

const briefDescriptionSchema = v.strictObject({ markdown: v.string() });

/** The retained Brief of one run as Markdown, composed by the main process. */
async function loadBriefPullRequestDescription(body: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly runId: string;
}): Promise<string> {
  const parsed = v.safeParse(
    briefDescriptionSchema,
    await requestJson("/v1/reviews/insights/brief/pull-request-description", {
      method: "POST",
      body,
    }),
  );
  if (!parsed.success) throw new Error("Unexpected PR description response");
  return parsed.output.markdown;
}

export function buildInsightReaders({
  workbench,
  patchFiles,
  selectedInsight,
  onFinishWithAnalysisSummary,
  addFinding,
  addAllFindings,
  localApply,
  localDrafts,
  walkthroughDiffAuthoring,
  dismissFinding,
  restoreFinding,
  analysisVerification,
  walkthroughProgress,
  onOpenFindingInDiff,
  onOpenFileInDiff,
  onOpenScopeBucketInDiff,
  walkthroughFocused,
  setWalkthroughFocused,
  onRegenerateBrief,
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
  // A local Review has no checks or discussion (ADR 0050).
  const pullRequestReview =
    workbench.session.key.source.kind === "pull_request";
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
        {...(!pullRequestReview ||
        (workbench.review.status !== "open" &&
          workbench.checks.overall === "unknown")
          ? {}
          : { checkStatus: workbench.checks.overall })}
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
        {...definedProps({ localDrafts })}
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
        // The server refuses Add, Dismiss, and Restore on a merged or closed Review.
        workbench.review.status === "open"
          ? {
              onDismissFinding: dismissFinding,
              onRestoreFinding: restoreFinding,
              ...definedProps({
                onAddFinding: addFinding,
                addAllFindings,
                localApply,
              }),
            }
          : {})}
      />
    ) : null;
  const walkthroughRetained = workbench.insights.walkthrough.retained;
  const walkthroughRevision =
    walkthroughRetained === undefined
      ? undefined
      : walkthroughDiscussionState(
          workbench,
          walkthroughRetained.value.snapshot,
        );
  const walkthroughDiscussion = pullRequestReview
    ? walkthroughRevision
    : undefined;
  // A Walkthrough of an older revision numbers the lines of another diff, so it takes no notes or comments (#598).
  const walkthroughAuthoring =
    walkthroughRevision === undefined ||
    walkthroughRevision === "stale" ||
    workbench.fullPatch === undefined
      ? undefined
      : walkthroughDiffAuthoring;
  const walkthroughAnnotations =
    walkthroughDiscussion === "available" && workbench.fullPatch !== undefined
      ? projectReadOnlyConversationAnnotations(
          patchFiles,
          workbench.conversation.inline?.threads ?? [],
        )
      : undefined;
  const firstDiffPath = patchFiles[0]?.newPath;
  const retainedWalkthrough =
    selectedInsight === "walkthrough" &&
    workbench.insights.walkthrough.retained !== undefined ? (
      <WalkthroughProgressReader
        key={JSON.stringify({
          sessionId: workbench.session.id,
          runId: workbench.insights.walkthrough.retained.runId,
          headSha: workbench.revision.reviewedHeadSha,
        })}
        walkthrough={workbench.insights.walkthrough.retained.value}
        controls={walkthroughProgress}
        {...(workbench.insights.walkthrough.status === "current" &&
        workbench.fullPatch !== undefined
          ? { rawPatch: workbench.fullPatch }
          : {})}
        {...(walkthroughAnnotations === undefined
          ? {}
          : { annotations: walkthroughAnnotations })}
        {...definedProps({ diffAuthoring: walkthroughAuthoring })}
        {...(walkthroughDiscussion === undefined ||
        walkthroughDiscussion === "available"
          ? {}
          : { discussionUnavailable: walkthroughDiscussion })}
        focused={walkthroughFocused}
        onFocusedChange={setWalkthroughFocused}
        {...(onOpenFileInDiff === undefined || firstDiffPath === undefined
          ? {}
          : { onOpenDiff: () => onOpenFileInDiff(firstDiffPath) })}
      />
    ) : null;
  const briefRetained = workbench.insights.brief?.retained;
  const briefRunId = briefRetained?.runId;
  const retainedBrief =
    selectedInsight === "brief" && briefRetained !== undefined ? (
      <BriefReader
        retained={briefRetained}
        {...(workbench.scope === undefined ? {} : { scope: workbench.scope })}
        {...(workbench.review.status === "open"
          ? { onRegenerate: onRegenerateBrief }
          : {})}
        regenerateDisabled={!runEnabled}
        {...definedProps({
          // The card shows the current revision's Scope, so an outdated Brief still filters the Diff.
          onScopeBucketSelect: onOpenScopeBucketInDiff,
        })}
        {...definedProps({
          // A local Review has no description yet; its Brief seeds one (ADR 0050 "Handoff").
          loadPullRequestDescription:
            pullRequestReview ||
            workbench.insights.brief?.status !== "current" ||
            briefRunId === undefined
              ? undefined
              : () =>
                  loadBriefPullRequestDescription({
                    profileId: workbench.session.key.profileId,
                    reviewId: workbench.review.id,
                    runId: briefRunId,
                  }),
        })}
      />
    ) : null;
  return retainedAnalysis ?? retainedWalkthrough ?? retainedBrief;
}
