import { useMemo } from "react";
import { useReviewConversationOwner } from "#src/renderer/src/hooks/use-review-conversation-owner";
import { definedProps } from "#src/domain/defined-props";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { LocalDraftControls } from "#src/renderer/src/flows/use-local-drafts";
import {
  usePendingReviewDrafts,
  type PendingReviewDrafts,
} from "#src/renderer/src/hooks/use-pending-review-drafts";
import type { ViewedFilesControls } from "#src/renderer/src/hooks/use-viewed-files";
import type { ReviewInlineAnnotation } from "./review-diff-view";
import {
  buildPendingReviewAnnotations,
  type LocalNoteAnnotationControls,
} from "./review-workbench-annotations";
import type { ReviewWorkbenchActions } from "./review-workbench-contracts";
import { pullRequestExternalRef } from "./review-workbench-pull-request";
import {
  useWalkthroughDiffAuthoring,
  type WalkthroughDiffAuthoring,
} from "./walkthrough-diff-authoring";

/** Shares session drafts, note controls, and diff authoring across workbench readers. */
export type ReviewWorkbenchAuthoring = {
  readonly pendingReviewDrafts: PendingReviewDrafts;
  readonly pendingReviewAnnotations: ReadonlyArray<ReviewInlineAnnotation>;
  readonly noteControls: LocalNoteAnnotationControls;
  readonly walkthroughDiffAuthoring: WalkthroughDiffAuthoring;
};

/** Keeps drafts and note controls above the Diff and Insights tab lifetimes. */
export function useReviewWorkbenchAuthoring({
  model,
  actions,
  localDrafts,
  viewedFiles,
  conversationAnnotations,
  reportUnsent,
}: {
  readonly model: WorkbenchResponse;
  readonly actions: ReviewWorkbenchActions;
  readonly localDrafts: LocalDraftControls | undefined;
  readonly viewedFiles: ViewedFilesControls | undefined;
  readonly conversationAnnotations: ReadonlyArray<ReviewInlineAnnotation>;
  readonly reportUnsent: (fieldId: string, unsent: boolean) => void;
}): ReviewWorkbenchAuthoring {
  const conversationOwner = useReviewConversationOwner(
    model.review.id,
    model.session.id,
    conversationAnnotations,
    { reportUnsent },
  );
  const pendingDrafts = usePendingReviewDrafts(
    model.review.id,
    model.fullPatch,
  );
  const pendingReviewDrafts = useMemo(
    () => ({ ...pendingDrafts, conversationOwner }),
    [pendingDrafts, conversationOwner],
  );
  const pendingReview = model.pendingReview;
  const pendingReviewAnnotations = useMemo(
    () => buildPendingReviewAnnotations({ pendingReview }),
    [pendingReview],
  );
  const noteReplies = localDrafts?.replies;
  const setNoteResolved = localDrafts?.setResolved;
  const noteControls = useMemo(
    (): LocalNoteAnnotationControls =>
      definedProps({
        notes: actions.localNotes,
        replies: noteReplies,
        setResolved: setNoteResolved,
      }),
    [actions.localNotes, noteReplies, setNoteResolved],
  );
  const authoring = useWalkthroughDiffAuthoring({
    model,
    actions,
    noteControls,
    pendingReviewDrafts,
    pendingReviewAnnotations,
  });
  const pullRequest = useMemo(() => pullRequestExternalRef(model), [model]);
  const profileId = model.session.key.profileId;
  const walkthroughDiffAuthoring = useMemo(
    () => ({
      ...authoring,
      ...definedProps({ viewedFiles }),
      conversationAnnotations,
      bodyContext: definedProps({ pullRequest, profileId }),
    }),
    [authoring, conversationAnnotations, viewedFiles, pullRequest, profileId],
  );
  return {
    pendingReviewDrafts,
    pendingReviewAnnotations,
    noteControls,
    walkthroughDiffAuthoring,
  };
}
