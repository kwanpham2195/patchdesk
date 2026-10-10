import { createContext, useMemo } from "react";

import { definedProps } from "#src/domain/defined-props";
import type { ViewedFilesControls } from "#src/renderer/src/hooks/use-viewed-files";
import type { PendingReviewDrafts } from "#src/renderer/src/hooks/use-pending-review-drafts";
import { localNotePlacementInput } from "#src/renderer/src/local-draft-placement";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type {
  LocalCommentAuthoring,
  PendingReviewComposerActions,
  ReviewConversationActions,
  ReviewInlineAnnotation,
} from "./review-diff-view";
import {
  buildAgentExplanationAnnotations,
  buildLocalNoteAnnotations,
  type LocalNoteAnnotationControls,
} from "./review-workbench-annotations";
import type { ReviewWorkbenchActions } from "./review-workbench-contracts";
import type { PullRequestBodyContext } from "./pull-request-description";

/** The Diff tab's note and comment authoring as a Walkthrough hunk uses it, so both write to the same lists (#598). */
export type WalkthroughDiffAuthoring = {
  /** GitHub-authored evidence resolves against the Review's PR and profile, not a checkout. */
  readonly bodyContext?: PullRequestBodyContext;
  readonly localCommentAuthoring?: LocalCommentAuthoring;
  readonly pendingReviewComposer?: PendingReviewComposerActions;
  readonly pendingReviewDrafts: PendingReviewDrafts;
  readonly conversationActions: ReviewConversationActions;
  /** Pending-review comments, a local Review's notes, and its Agent explanations at their Combined lines; published threads come from the Walkthrough's own discussion rule. */
  readonly annotations: ReadonlyArray<ReviewInlineAnnotation>;
  /** Combined file marks shared with Guide; absent when Diff shows another patch view. */
  readonly viewedFiles?: ViewedFilesControls;
  /** Full-file discussion for Guide; Walkthrough keeps its cited-hunk discussion rule. */
  readonly conversationAnnotations?: ReadonlyArray<ReviewInlineAnnotation>;
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
  noteControls,
  pendingReviewDrafts,
  pendingReviewAnnotations,
}: {
  readonly model: Pick<
    WorkbenchResponse,
    "session" | "patchViews" | "fullPatch" | "localDrafts" | "agentExplanations"
  >;
  readonly actions: ReviewWorkbenchActions;
  /** The Diff tab's note card controls, so a card's reply and Resolve match there (#688). */
  readonly noteControls: LocalNoteAnnotationControls;
  readonly pendingReviewDrafts: PendingReviewDrafts;
  readonly pendingReviewAnnotations: ReadonlyArray<ReviewInlineAnnotation>;
}): WalkthroughDiffAuthoring {
  const {
    localCommentAuthoring: diffAuthoring,
    localNotes,
    dismissAgentExplanation,
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
  const { patchViews, fullPatch, localDrafts, agentExplanations } = model;
  const annotations = useMemo(() => {
    const placement = {
      sessionId,
      view: patchViews === undefined ? undefined : ("combined" as const),
      notes:
        patchViews === undefined || fullPatch === undefined
          ? undefined
          : localNotePlacementInput(patchViews, "combined", fullPatch),
      analysisRunId: undefined,
      findings: [],
    };
    return [
      ...pendingReviewAnnotations,
      ...buildLocalNoteAnnotations(localDrafts ?? [], noteControls, placement),
      ...buildAgentExplanationAnnotations(
        agentExplanations ?? [],
        dismissAgentExplanation,
        placement,
      ),
    ];
  }, [
    agentExplanations,
    dismissAgentExplanation,
    fullPatch,
    localDrafts,
    noteControls,
    patchViews,
    pendingReviewAnnotations,
    sessionId,
  ]);
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
