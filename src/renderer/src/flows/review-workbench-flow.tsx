import { parseRepoRelativePath } from "../../../domain/ids";
import {
  ReviewWorkbench,
  type ReviewWorkbenchInitialState,
} from "../components/review-workbench";
import type { AssigneesSectionActions } from "../components/assignee-picker";
import type { LabelPickerActions } from "../components/label-picker";
import type { ReviewerPickerActions } from "../components/reviewer-picker";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
import type { WorkbenchResponse } from "../renderer-contracts";

import { InsightsSlot } from "../components/review-insights-slot";
import { loadReviewCommitDiff } from "./review-workbench-commit-diff";
import { useAnalysisReviewActions } from "./use-analysis-review-actions";
import { useDirectConversationActions } from "./use-direct-conversation-actions";
import { useDirectSummaryActions } from "./use-direct-summary-actions";
import { usePendingReviewActions } from "./use-pending-review-actions";
import { useReviewMetadataActions } from "./use-review-metadata-actions";
import { useReviewMergeAction } from "./use-review-merge-action";
import { useReviewWriteRecovery } from "./use-review-write-recovery";
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
  const {
    saveInlineComment,
    setThreadState,
    replyToThread,
    editComment,
    deleteComment,
    dismissReview,
  } = useDirectConversationActions({
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
  const {
    fetchLabels,
    addLabels,
    removeLabels,
    fetchAssignableUsers,
    addAssignees,
    removeAssignees,
    assignSelf,
    fetchReviewers,
    requestReviewers,
    removeReviewers,
  } = useReviewMetadataActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
    observeConfirmedReviewWrite,
    requireRecovery: writeRecovery.requireRecovery,
  });
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
  const localCommentAuthoring: LocalCommentAuthoring | undefined =
    canWriteDirectConversation
      ? {
          enabled: true,
          onSave: saveInlineComment,
          onSelectionChange: (location) => {
            const path = parseRepoRelativePath(location.path);
            if (path._tag === "ok") void path;
          },
        }
      : undefined;
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

  const conversationActions = canWriteDirectConversation
    ? {
        setThreadState,
        replyToThread,
        editComment,
        deleteComment,
        dismissReview,
      }
    : undefined;
  const labelActions: LabelPickerActions | undefined = canWriteLabels
    ? { fetchLabels, addLabels, removeLabels }
    : undefined;
  const assigneeActions: AssigneesSectionActions | undefined = canWriteAssignees
    ? { fetchAssignableUsers, addAssignees, removeAssignees, assignSelf }
    : undefined;
  const reviewerActions: ReviewerPickerActions | undefined = canWriteReviewers
    ? { fetchReviewers, requestReviewers, removeReviewers }
    : undefined;

  const workbenchActionsBase = {
    detectUpdates: runDetect,
    refresh,
    loadCommitDiff: (commitSha: string) =>
      loadReviewCommitDiff(
        workbench.session.key.profileId,
        workbench.review.id,
        commitSha,
      ),
    reportNavigationState: onNavigationStateChange,
  };
  const workbenchActionsWithRefreshing =
    refreshing === true
      ? { ...workbenchActionsBase, refreshing: true as const }
      : workbenchActionsBase;
  const workbenchActionsWithRefreshError =
    refreshError === true
      ? { ...workbenchActionsWithRefreshing, refreshError: true as const }
      : workbenchActionsWithRefreshing;
  const workbenchActionsWithMerge =
    mergeAction === undefined || writeRecovery.githubWritesLocked
      ? workbenchActionsWithRefreshError
      : { ...workbenchActionsWithRefreshError, merge: mergeAction };
  const workbenchActionsWithLocalCommentAuthoring =
    localCommentAuthoring === undefined
      ? workbenchActionsWithMerge
      : { ...workbenchActionsWithMerge, localCommentAuthoring };
  const workbenchActionsWithPendingReviewComposer =
    pendingReviewComposer === undefined || writeRecovery.githubWritesLocked
      ? workbenchActionsWithLocalCommentAuthoring
      : {
          ...workbenchActionsWithLocalCommentAuthoring,
          pendingReviewComposer,
        };
  const workbenchActionsWithPendingReviewPanel =
    pendingReview === undefined || writeRecovery.githubWritesLocked
      ? workbenchActionsWithPendingReviewComposer
      : {
          ...workbenchActionsWithPendingReviewComposer,
          pendingReview,
        };
  const workbenchActionsWithDirectSummaryPanel =
    directSummary === undefined || writeRecovery.githubWritesLocked
      ? workbenchActionsWithPendingReviewPanel
      : {
          ...workbenchActionsWithPendingReviewPanel,
          directSummary,
        };
  const workbenchActionsWithLabels =
    labelActions === undefined
      ? workbenchActionsWithDirectSummaryPanel
      : { ...workbenchActionsWithDirectSummaryPanel, labels: labelActions };
  const workbenchActionsWithAssignees =
    assigneeActions === undefined
      ? workbenchActionsWithLabels
      : { ...workbenchActionsWithLabels, assignees: assigneeActions };
  const workbenchActionsWithReviewers =
    reviewerActions === undefined
      ? workbenchActionsWithAssignees
      : { ...workbenchActionsWithAssignees, reviewers: reviewerActions };
  const workbenchActions =
    conversationActions === undefined
      ? workbenchActionsWithReviewers
      : { ...workbenchActionsWithReviewers, ...conversationActions };

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
        slots={{
          insights: (
            <InsightsSlot
              workbench={workbench}
              {...(initialUiState?.insightDetail === undefined
                ? {}
                : { initialDetail: initialUiState.insightDetail })}
              onWorkbenchReplace={replaceWorkbench}
              onWorkbenchPatch={onWorkbenchPatch}
              {...(writeRecovery.githubWritesLocked
                ? {}
                : {
                    onAddFinding: addFindingToPendingReview,
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
              ? "Patchdesk found more than one possible GitHub result. Review the pull request on GitHub before continuing."
              : "A GitHub write may have completed. Check GitHub again before making another change."}
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
          GitHub state could not be refreshed. The represented Review remains
          readable.
        </InlineError>
      ) : null}
    </>
  );
}
