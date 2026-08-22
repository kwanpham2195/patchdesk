import { parseRepoRelativePath } from "../../../domain/ids";
import { requestJson } from "../api-client";
import {
  ReviewWorkbench,
  type ReviewWorkbenchInitialState,
} from "../components/review-workbench";
import type { AssigneesSectionActions } from "../components/assignee-picker";
import type { LabelPickerActions } from "../components/label-picker";
import type { ReviewerPickerActions } from "../components/reviewer-picker";
import type { ReviewNavigatorSection } from "../components/review-navigator";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
import {
  parseCommitDiffResponse,
  type CommitDiffResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";

import { InsightsSlot } from "../components/review-insights-slot";
import { useAnalysisReviewActions } from "./use-analysis-review-actions";
import { useDirectConversationActions } from "./use-direct-conversation-actions";
import { useDirectSummaryActions } from "./use-direct-summary-actions";
import { usePendingReviewActions } from "./use-pending-review-actions";
import { useReviewMetadataActions } from "./use-review-metadata-actions";
import { useReviewMergeAction } from "./use-review-merge-action";
import {
  useReviewObservation,
  type ReviewWorkbenchPatch,
} from "./use-review-observation";

export type { ReviewWorkbenchPatch } from "./use-review-observation";

export type ReviewWorkbenchFlowProps = {
  readonly workbench: WorkbenchResponse;
  readonly initialSection?: "diff" | "checks";
  readonly initialUiState?: ReviewWorkbenchInitialState;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onNavigationStateChange: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
  readonly onNavigate: (section: "diff" | "checks") => void;
  /** Reports in-screen position changes so a reload can restore them. */
  readonly onUiStateChange?: (state: {
    readonly activeTab: "conversation" | "diff" | "insights";
    readonly section: ReviewNavigatorSection;
    readonly selectedPath?: string;
  }) => void;
};

/** Owns loopback calls and replacement of the one canonical Review projection. */
export function ReviewWorkbenchFlow({
  workbench,
  initialSection,
  initialUiState,
  onWorkbenchReplace,
  onWorkbenchPatch,
  onNavigationStateChange,
  onNavigate,
  onUiStateChange,
}: ReviewWorkbenchFlowProps): React.JSX.Element {
  void initialSection;
  void onNavigate;
  const {
    refreshing,
    refreshError,
    runDetect,
    refresh,
    replaceWorkbench,
    runDirectCommand,
    observeConfirmedDirectSummary,
    appendRecentWrites,
  } = useReviewObservation({
    workbench,
    onWorkbenchReplace,
    onWorkbenchPatch,
  });
  const {
    saveInlineComment,
    setThreadState,
    replyToThread,
    editComment,
    deleteComment,
  } = useDirectConversationActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
  });
  // Labels, assignees, and reviewers are pull-request-level metadata. Their
  // eligibility remains a projection concern; the hook owns only their reads,
  // writes, receipt parsing, and recent-write journal entries.
  const canWriteLabels = workbench.review.status === "open";
  const canWriteAssignees = workbench.review.status === "open";
  const canWriteReviewers = workbench.review.status === "open";
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
  });
  const canWriteDirectConversation =
    workbench.review.status === "open" &&
    workbench.revision.freshness === "fresh" &&
    workbench.revision.patchHash !== undefined;
  const { pendingReviewComposer, pendingReview, openFinishDialogWithSummary } =
    usePendingReviewActions({
      workbench,
      onWorkbenchReplace: replaceWorkbench,
      onWorkbenchPatch,
      appendRecentWrites,
    });
  const { directSummary } = useDirectSummaryActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
    observeConfirmedDirectSummary,
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
  });
  const { addFindingToPendingReview } = useAnalysisReviewActions({
    workbench,
    onWorkbenchReplace: replaceWorkbench,
  });

  const conversationActions = canWriteDirectConversation
    ? { setThreadState, replyToThread, editComment, deleteComment }
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
    loadCommitDiff: async (commitSha: string): Promise<CommitDiffResponse> => {
      const value = await requestJson("/v1/reviews/commit-diff", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
          commitSha,
        },
      });
      const parsed = parseCommitDiffResponse(value);
      if (parsed === undefined) throw new Error("Invalid commit diff response");
      return parsed;
    },
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
    mergeAction === undefined
      ? workbenchActionsWithRefreshError
      : { ...workbenchActionsWithRefreshError, merge: mergeAction };
  const workbenchActionsWithLocalCommentAuthoring =
    localCommentAuthoring === undefined
      ? workbenchActionsWithMerge
      : { ...workbenchActionsWithMerge, localCommentAuthoring };
  const workbenchActionsWithPendingReviewComposer =
    pendingReviewComposer === undefined
      ? workbenchActionsWithLocalCommentAuthoring
      : {
          ...workbenchActionsWithLocalCommentAuthoring,
          pendingReviewComposer,
        };
  const workbenchActionsWithPendingReviewPanel =
    pendingReview === undefined
      ? workbenchActionsWithPendingReviewComposer
      : {
          ...workbenchActionsWithPendingReviewComposer,
          pendingReview,
        };
  const workbenchActionsWithDirectSummaryPanel =
    directSummary === undefined
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
              onAddFinding={addFindingToPendingReview}
              onFinishWithAnalysisSummary={openFinishDialogWithSummary}
            />
          ),
          conversation: null,
          mergeAction: null,
        }}
      />
      {refreshError ? (
        <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
          GitHub state could not be refreshed. The represented Review remains
          readable.
        </p>
      ) : null}
      {refreshing ? (
        <span className="sr-only" role="status">
          Refreshing Review state
        </span>
      ) : null}
    </>
  );
}
