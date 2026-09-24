import {
  ReviewWorkbench,
  type ReviewWorkbenchInitialState,
} from "../components/review-workbench";
import type { WorkbenchResponse } from "../renderer-contracts";

import { InsightsSlot } from "../components/review-insights-slot";
import { useWorkbenchActions } from "./use-workbench-actions";
import { useAnalysisReviewActions } from "./use-analysis-review-actions";
import { useAddAllFindings } from "./use-add-all-findings";
import { useDirectConversationActions } from "./use-direct-conversation-actions";
import { useDirectSummaryActions } from "./use-direct-summary-actions";
import { usePendingReviewActions } from "./use-pending-review-actions";
import { useReviewMetadataActions } from "./use-review-metadata-actions";
import { useReviewMergeAction } from "./use-review-merge-action";
import { useReviewWriteRecovery } from "./use-review-write-recovery";
import { useViewedFiles } from "../hooks/use-viewed-files";
import {
  useReviewObservation,
  type ReviewWorkbenchPatch,
} from "./use-review-observation";
import type { WorkbenchPosition } from "../lib/screen-restore";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { InlineError } from "../components/ui/inline-error";
import { Spinner } from "../components/ui/spinner";

export type { ReviewWorkbenchPatch } from "./use-review-observation";

export type ReviewWorkbenchFlowProps = {
  readonly workbench: WorkbenchResponse;
  readonly initialUiState?: ReviewWorkbenchInitialState;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onNavigationStateChange: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
  /** Reports in-screen position changes so a reload can restore them. */
  readonly onUiStateChange?: (state: WorkbenchPosition) => void;
};

/** Owns loopback calls and replacement of the one canonical Review projection. */
export function ReviewWorkbenchFlow({
  workbench,
  initialUiState,
  onWorkbenchReplace,
  onWorkbenchPatch,
  onNavigationStateChange,
  onUiStateChange,
}: ReviewWorkbenchFlowProps): React.JSX.Element {
  const {
    refreshing,
    refreshError,
    runDetect,
    refresh,
    requestRefresh,
    requestReprepare,
    replaceWorkbench,
    runDirectCommand,
    observeConfirmedReviewWrite,
    appendRecentWrites,
  } = useReviewObservation({
    workbench,
    onWorkbenchReplace,
    onWorkbenchPatch,
  });
  const writeRecovery = useReviewWriteRecovery({
    workbench,
    onWorkbenchReplace: replaceWorkbench,
  });
  const conversation = useDirectConversationActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
    observeConfirmedReviewWrite,
    requireRecovery: writeRecovery.requireRecovery,
  });
  // Labels, assignees, and reviewers are pull-request-level metadata. Their
  // eligibility remains a projection concern; the hook owns only their reads,
  // writes, receipt parsing, and recent-write journal entries.
  const canWriteLabels =
    workbench.review.status === "open" && !writeRecovery.githubWritesLocked;
  const canWriteAssignees =
    workbench.review.status === "open" && !writeRecovery.githubWritesLocked;
  const canWriteReviewers =
    workbench.review.status === "open" && !writeRecovery.githubWritesLocked;
  // The draft toggle is the author's own control, and repository permission
  // is not projected here, so this gates on author-is-viewer. The narrowing is
  // that a non-author maintainer is not offered it; DraftStateService still
  // resolves permission on every write.
  const canWriteDraftState =
    workbench.review.status === "open" &&
    !writeRecovery.githubWritesLocked &&
    workbench.pullRequest?.author.toLowerCase() ===
      workbench.viewerLogin.toLowerCase();
  const metadata = useReviewMetadataActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
    observeConfirmedReviewWrite,
    requireRecovery: writeRecovery.requireRecovery,
    requestRefresh,
  });
  // Permission is read with the branch list and enforced by BaseBranchService.
  const canWriteBaseBranch =
    workbench.review.status === "open" && !writeRecovery.githubWritesLocked;
  const canWriteDirectConversation =
    workbench.review.status === "open" &&
    !writeRecovery.githubWritesLocked &&
    workbench.revision.freshness === "fresh" &&
    workbench.revision.patchHash !== undefined;
  const { pendingReviewComposer, pendingReview, openFinishDialogWithSummary } =
    usePendingReviewActions({
      workbench,
      onWorkbenchReplace: replaceWorkbench,
      onWorkbenchPatch,
      runDirectCommand,
      appendRecentWrites,
      observeConfirmedReviewWrite,
    });
  const { directSummary } = useDirectSummaryActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
    observeConfirmedDirectSummary: (reviewId) =>
      observeConfirmedReviewWrite([{ _tag: "DirectSummaryReview", reviewId }]),
  });
  const { mergeAction } = useReviewMergeAction({
    workbench,
    onWorkbenchReplace: replaceWorkbench,
    runDirectCommand,
  });
  const { addFindingToPendingReview } = useAnalysisReviewActions({
    workbench,
    onWorkbenchReplace: replaceWorkbench,
    runDirectCommand,
  });
  const addAllFindings = useAddAllFindings({
    addFinding: addFindingToPendingReview,
    reviewScope: JSON.stringify([
      workbench.session.id,
      workbench.revision.reviewedHeadSha,
      workbench.revision.patchHash,
      workbench.insights.analysis.retained?.runId,
    ]),
  });
  // A batch Add writes to the pending review, so it holds the same busy state: navigation waits and Finish and inline comments stay disabled.
  const findingBatchRunning = addAllFindings.progress !== undefined;

  const viewedFiles = useViewedFiles({
    profileId: workbench.session.key.profileId,
    reviewId: workbench.review.id,
    sessionId: workbench.session.id,
    savedPaths: workbench.viewedPaths,
    onWorkbenchPatch,
  });

  const workbenchActions = useWorkbenchActions({
    profileId: workbench.session.key.profileId,
    reviewId: workbench.review.id,
    capabilities: {
      labels: canWriteLabels,
      assignees: canWriteAssignees,
      reviewers: canWriteReviewers,
      draftState: canWriteDraftState,
      baseBranch: canWriteBaseBranch,
      directConversation: canWriteDirectConversation,
      githubWritesLocked: writeRecovery.githubWritesLocked,
    },
    metadata,
    conversation,
    observation: { runDetect, refresh, refreshing, refreshError },
    merge: mergeAction,
    pendingReviewComposer:
      pendingReviewComposer === undefined || !findingBatchRunning
        ? pendingReviewComposer
        : { ...pendingReviewComposer, busy: true },
    pendingReview:
      pendingReview === undefined || !findingBatchRunning
        ? pendingReview
        : { ...pendingReview, busy: true },
    directSummary,
    reportNavigationState: onNavigationStateChange,
  });

  return (
    <>
      <ReviewWorkbench
        model={workbench}
        {...(initialUiState === undefined
          ? {}
          : { initialState: initialUiState })}
        {...(onUiStateChange === undefined
          ? {}
          : { onPositionCommitted: onUiStateChange })}
        actions={workbenchActions}
        viewedFiles={viewedFiles}
        slots={{
          insights: (
            <InsightsSlot
              workbench={workbench}
              {...(initialUiState?.insightDetail === undefined
                ? {}
                : { initialDetail: initialUiState.insightDetail })}
              onWorkbenchReplace={replaceWorkbench}
              onWorkbenchPatch={onWorkbenchPatch}
              onReprepare={requestReprepare}
              {...(writeRecovery.githubWritesLocked
                ? {}
                : {
                    // A single Add ignores the result; only the batch stops on a Review change.
                    onAddFinding: async (finding) => {
                      await addFindingToPendingReview(finding);
                    },
                    addAllFindings,
                    onFinishWithAnalysisSummary: openFinishDialogWithSummary,
                  })}
            />
          ),
          conversation: null,
          mergeAction: null,
        }}
      />
      {writeRecovery.recovery === undefined ? null : (
        <Alert className="mx-4 my-2" data-review-write-recovery>
          <AlertTitle>GitHub writes are paused</AlertTitle>
          <AlertDescription>
            {writeRecovery.recovery.resolution === "manual_resolution_required"
              ? "GitHub gave an ambiguous result. Check the pull request on GitHub before continuing."
              : "A GitHub write may have completed. Check GitHub before another change."}
            {writeRecovery.recoveryError === undefined ? null : (
              <p data-review-write-recovery-error>
                {writeRecovery.recoveryError === "invalid_response"
                  ? "Patchdesk received an invalid recovery response. GitHub writes remain paused."
                  : "Patchdesk could not check GitHub. GitHub writes remain paused."}
              </p>
            )}
          </AlertDescription>
          {writeRecovery.recovery.resolution ===
          "manual_resolution_required" ? null : (
            <AlertAction>
              <Button
                size="sm"
                variant="outline"
                disabled={writeRecovery.checking}
                onClick={() => void writeRecovery.checkGitHubAgain()}
              >
                {writeRecovery.checking ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {writeRecovery.checking ? "Checking…" : "Check GitHub again"}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {refreshError ? (
        <InlineError className="border-t px-4 py-2">
          {refreshError === "interrupted"
            ? "The refresh was interrupted. Retry when ready."
            : refreshError === "github_auth"
              ? "GitHub sign-in expired during refresh. Sign in again, then retry."
              : refreshError === "head_changed"
                ? "The pull request changed during refresh. Retry to read the latest revision."
                : refreshError === "terminal"
                  ? "The pull request closed or merged during refresh. Reload it from the repository list."
                  : "GitHub state could not be refreshed. Retry when ready."}
        </InlineError>
      ) : null}
    </>
  );
}
