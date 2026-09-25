import { useCallback, useMemo } from "react";

import { definedProps } from "../../../domain/defined-props";
import { parseRepoRelativePath } from "../../../domain/ids";
import type { AssigneesSectionActions } from "../components/assignee-picker";
import type { ChangeBaseBranchActions } from "../components/change-base-branch-dialog";
import type { LabelPickerActions } from "../components/label-picker";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
import type { ReviewWorkbenchActions } from "../components/review-workbench";
import type { ReviewerPickerActions } from "../components/reviewer-picker";
import {
  loadReviewCommitDiff,
  loadReviewSinceReviewDiff,
} from "./review-workbench-commit-diff";
import type { DirectConversationActions } from "./use-direct-conversation-actions";
import type { ChangeIntentControls } from "./use-change-intent";
import type { LocalNoteControls } from "./use-local-drafts";
import type { PendingReviewActionsResult } from "./use-pending-review-actions";
import type { ReviewMetadataActions } from "./use-review-metadata-actions";
import type { ReviewObservationResult } from "./use-review-observation";

/** What this Review may write, as the flow resolved it from the projection and the write-recovery lock. */
type WorkbenchWriteCapabilities = {
  readonly labels: boolean;
  readonly assignees: boolean;
  readonly reviewers: boolean;
  readonly draftState: boolean;
  readonly baseBranch: boolean;
  readonly directConversation: boolean;
  /** Withholds every GitHub write until the maintainer resolves the recovery. */
  readonly githubWritesLocked: boolean;
};

export type WorkbenchActionsInput = {
  readonly profileId: string;
  readonly reviewId: string;
  readonly capabilities: WorkbenchWriteCapabilities;
  readonly metadata: ReviewMetadataActions;
  readonly conversation: DirectConversationActions;
  /** A local Review's maintainer notes; the diff composer adds one instead of a GitHub comment. */
  readonly localNotes: LocalNoteControls | undefined;
  readonly changeIntent: ChangeIntentControls | undefined;
  readonly observation: Pick<
    ReviewObservationResult,
    "refresh" | "refreshError" | "refreshing" | "runDetect"
  >;
  readonly merge: ReviewWorkbenchActions["merge"];
  readonly pendingReviewComposer: PendingReviewActionsResult["pendingReviewComposer"];
  readonly pendingReview: PendingReviewActionsResult["pendingReview"];
  readonly directSummary: ReviewWorkbenchActions["directSummary"];
  readonly reportNavigationState: ReviewWorkbenchActions["reportNavigationState"];
};

/**
 * Composes the one actions object `ReviewWorkbench` takes.
 *
 * Every group is memoised on the callbacks it holds rather than rebuilt per
 * render: the metadata rail's Reviewers and Assignees sections read GitHub
 * whenever the group they were handed changes identity, and each read is a
 * second or more of GitHub traffic.
 */
export function useWorkbenchActions({
  profileId,
  reviewId,
  capabilities,
  metadata,
  conversation,
  localNotes,
  changeIntent,
  observation,
  merge,
  pendingReviewComposer,
  pendingReview,
  directSummary,
  reportNavigationState,
}: WorkbenchActionsInput): ReviewWorkbenchActions {
  const {
    labels: canWriteLabels,
    assignees: canWriteAssignees,
    reviewers: canWriteReviewers,
    draftState: canWriteDraftState,
    baseBranch: canWriteBaseBranch,
    directConversation: canWriteDirectConversation,
    githubWritesLocked,
  } = capabilities;
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
    setDraftState,
    fetchBaseBranches,
    setBaseBranch,
  } = metadata;
  const {
    saveInlineComment,
    setThreadState,
    replyToThread,
    editComment,
    deleteComment,
    dismissReview,
  } = conversation;
  const { runDetect, refresh, refreshing, refreshError } = observation;

  const loadCommitDiff = useCallback(
    (commitSha: string) => loadReviewCommitDiff(profileId, reviewId, commitSha),
    [profileId, reviewId],
  );
  const loadSinceReviewDiff = useCallback(
    () => loadReviewSinceReviewDiff(profileId, reviewId),
    [profileId, reviewId],
  );
  const localCommentAuthoring: LocalCommentAuthoring | undefined = useMemo(
    () =>
      canWriteDirectConversation
        ? {
            enabled: true,
            onSave: saveInlineComment,
            onSelectionChange: (location) => {
              const path = parseRepoRelativePath(location.path);
              if (path._tag === "ok") void path;
            },
          }
        : localNotes === undefined
          ? undefined
          : {
              enabled: true,
              kind: "note",
              onSave: ({ path, startLine, line, side, body }) =>
                localNotes.add({ path, startLine, line, side }, body),
            },
    [canWriteDirectConversation, localNotes, saveInlineComment],
  );
  const conversationActions = useMemo(
    () =>
      canWriteDirectConversation
        ? {
            setThreadState,
            replyToThread,
            editComment,
            deleteComment,
            dismissReview,
          }
        : undefined,
    [
      canWriteDirectConversation,
      deleteComment,
      dismissReview,
      editComment,
      replyToThread,
      setThreadState,
    ],
  );
  const labelActions: LabelPickerActions | undefined = useMemo(
    () =>
      canWriteLabels ? { fetchLabels, addLabels, removeLabels } : undefined,
    [addLabels, canWriteLabels, fetchLabels, removeLabels],
  );
  const assigneeActions: AssigneesSectionActions | undefined = useMemo(
    () =>
      canWriteAssignees
        ? { fetchAssignableUsers, addAssignees, removeAssignees, assignSelf }
        : undefined,
    [
      addAssignees,
      assignSelf,
      canWriteAssignees,
      fetchAssignableUsers,
      removeAssignees,
    ],
  );
  const reviewerActions: ReviewerPickerActions | undefined = useMemo(
    () =>
      canWriteReviewers
        ? { fetchReviewers, requestReviewers, removeReviewers }
        : undefined,
    [canWriteReviewers, fetchReviewers, removeReviewers, requestReviewers],
  );
  const baseBranchActions: ChangeBaseBranchActions | undefined = useMemo(
    () =>
      canWriteBaseBranch
        ? { fetchBaseBranches, setBaseBranch, refresh }
        : undefined,
    [canWriteBaseBranch, fetchBaseBranches, refresh, setBaseBranch],
  );
  const draftStateAction = canWriteDraftState ? setDraftState : undefined;

  return useMemo(
    () => ({
      detectUpdates: runDetect,
      refresh,
      loadCommitDiff,
      loadSinceReviewDiff,
      reportNavigationState,
      ...definedProps({
        refreshing: refreshing ? (true as const) : undefined,
        refreshError: refreshError ? (true as const) : undefined,
        merge: githubWritesLocked ? undefined : merge,
        localCommentAuthoring,
        localNotes,
        changeIntent,
        pendingReviewComposer: githubWritesLocked
          ? undefined
          : pendingReviewComposer,
        pendingReview: githubWritesLocked ? undefined : pendingReview,
        directSummary: githubWritesLocked ? undefined : directSummary,
        labels: labelActions,
        assignees: assigneeActions,
        reviewers: reviewerActions,
        setDraftState: draftStateAction,
        baseBranch: baseBranchActions,
      }),
      ...conversationActions,
    }),
    [
      assigneeActions,
      baseBranchActions,
      changeIntent,
      conversationActions,
      directSummary,
      draftStateAction,
      githubWritesLocked,
      labelActions,
      loadCommitDiff,
      loadSinceReviewDiff,
      localCommentAuthoring,
      localNotes,
      merge,
      pendingReview,
      pendingReviewComposer,
      refresh,
      refreshError,
      refreshing,
      reportNavigationState,
      reviewerActions,
      runDetect,
    ],
  );
}
