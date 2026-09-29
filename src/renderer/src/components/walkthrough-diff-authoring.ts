import { createContext, useMemo } from "react";

import { definedProps } from "../../../domain/defined-props";
import type { PendingReviewDrafts } from "../hooks/use-pending-review-drafts";
import { localNotePlacementInput } from "../local-draft-placement";
import type { WorkbenchResponse } from "../renderer-contracts";
import type {
  LocalCommentAuthoring,
  PendingReviewComposerActions,
  ReviewConversationActions,
  ReviewInlineAnnotation,
} from "./review-diff-view";
import { buildLocalNoteAnnotations } from "./review-workbench-annotations";
import type { ReviewWorkbenchActions } from "./review-workbench-contracts";

/** The Diff tab's note and comment authoring as a Walkthrough hunk uses it, so both write to the same lists (#598). */
export type WalkthroughDiffAuthoring = {
  readonly localCommentAuthoring?: LocalCommentAuthoring;
  readonly pendingReviewComposer?: PendingReviewComposerActions;
  readonly pendingReviewDrafts: PendingReviewDrafts;
  readonly conversationActions: ReviewConversationActions;
  /** Pending-review comments and a local Review's notes at their Combined lines; published threads come from the Walkthrough's own discussion rule. */
  readonly annotations: ReadonlyArray<ReviewInlineAnnotation>;
};

// The Insights slot is a ReactNode built by the flow, so the workbench hands
// it authoring through context rather than props.
export const WalkthroughDiffAuthoringContext = createContext<
  WalkthroughDiffAuthoring | undefined
>(undefined);

/**
 * Builds the Walkthrough's authoring from the workbench's. A Walkthrough shows
 * Combined line numbers whatever view the Diff tab shows, so its notes are
 * saved and placed in Combined.
 */
export function useWalkthroughDiffAuthoring({
  model,
  actions,
  pendingReviewDrafts,
  pendingReviewAnnotations,
}: {
  readonly model: Pick<
    WorkbenchResponse,
    "session" | "patchViews" | "fullPatch" | "localDrafts"
  >;
  readonly actions: ReviewWorkbenchActions;
  readonly pendingReviewDrafts: PendingReviewDrafts;
  readonly pendingReviewAnnotations: ReadonlyArray<ReviewInlineAnnotation>;
}): WalkthroughDiffAuthoring {
  const {
    localCommentAuthoring: diffAuthoring,
    localNotes,
    pendingReviewComposer,
    setThreadState,
    replyToThread,
    editComment,
    deleteComment,
  } = actions;
  const localCommentAuthoring = useMemo(
    (): LocalCommentAuthoring | undefined =>
      diffAuthoring?.kind === "note" && localNotes !== undefined
        ? {
            ...diffAuthoring,
            onSave: ({ path, startLine, line, side, body }) =>
              localNotes.add({ path, startLine, line, side }, body, "combined"),
          }
        : diffAuthoring,
    [diffAuthoring, localNotes],
  );
  const conversationActions = useMemo(
    () =>
      definedProps({
        setThreadState,
        replyToThread,
        editComment,
        deleteComment,
      }),
    [deleteComment, editComment, replyToThread, setThreadState],
  );
  const sessionId = model.session.id;
  const { patchViews, fullPatch, localDrafts } = model;
  const annotations = useMemo(
    () => [
      ...pendingReviewAnnotations,
      ...buildLocalNoteAnnotations(localDrafts ?? [], localNotes, {
        sessionId,
        view: patchViews === undefined ? undefined : "combined",
        notes:
          patchViews === undefined || fullPatch === undefined
            ? undefined
            : localNotePlacementInput(patchViews, "combined", fullPatch),
        analysisRunId: undefined,
        findings: [],
      }),
    ],
    [
      fullPatch,
      localDrafts,
      localNotes,
      patchViews,
      pendingReviewAnnotations,
      sessionId,
    ],
  );
  return useMemo(
    () => ({
      ...definedProps({ localCommentAuthoring, pendingReviewComposer }),
      pendingReviewDrafts,
      conversationActions,
      annotations,
    }),
    [
      annotations,
      conversationActions,
      localCommentAuthoring,
      pendingReviewComposer,
      pendingReviewDrafts,
    ],
  );
}
