import { definedProps } from "../../../domain/defined-props";
import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { parseGitHubThreadId } from "../../../domain/ids";
import {
  projectReadOnlyConversationAnnotations,
  type ReadOnlyConversationAnnotation,
} from "../inline-conversation-mapping";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { ReviewWorkbenchActions } from "./review-workbench";
import type { ReviewInlineAnnotation } from "./review-diff-view";
import type { ConversationThreadCardData } from "./conversation-thread-card";

/** The mapped Analysis findings the diff renders as inline annotations. */
export type MappedFinding = NonNullable<
  WorkbenchResponse["insights"]["analysis"]["retained"]
>["value"]["findings"][number];

/** Published conversation threads, anchored to the reviewed patch. */
export function buildReadOnlyConversationAnnotations(
  fullPatch: WorkbenchResponse["fullPatch"],
  inline: WorkbenchResponse["conversation"]["inline"],
): ReadonlyArray<ReadOnlyConversationAnnotation> {
  if (fullPatch === undefined) return [];
  return projectReadOnlyConversationAnnotations(
    parseUnifiedPatch(fullPatch),
    inline?.threads ?? [],
  );
}

/** Published threads as diff annotations, wired to the direct-conversation actions. */
export function buildConversationAnnotations(
  readOnlyConversationAnnotations: ReadonlyArray<ReadOnlyConversationAnnotation>,
  actions: {
    readonly setThreadState: ReviewWorkbenchActions["setThreadState"];
    readonly replyToThread: ReviewWorkbenchActions["replyToThread"];
    readonly editComment: ReviewWorkbenchActions["editComment"];
    readonly deleteComment: ReviewWorkbenchActions["deleteComment"];
  },
): ReadonlyArray<ReviewInlineAnnotation> {
  return readOnlyConversationAnnotations.flatMap((thread) => {
    // The wire model carries plain string ids; the annotation target needs
    // the verified GitHub thread id so Reply and Resolve are only reachable
    // through an id the mutation layer accepts.
    const parsedThreadId = parseGitHubThreadId(thread.id);
    if (parsedThreadId._tag === "err") return [];
    const conversationThread: ConversationThreadCardData = {
      target: { _tag: "thread" as const, id: parsedThreadId.value },
      state: thread.state,
      comments: thread.comments,
      ...definedProps({
        complete: thread.complete,
        onSetState: actions.setThreadState,
        onReply: actions.replyToThread,
        onEditComment: actions.editComment,
        onDeleteComment: actions.deleteComment,
      }),
    };
    return [
      {
        id: `conversation:${thread.id}`,
        path: thread.path,
        start: thread.start,
        end: thread.end,
        side: thread.side,
        severity: "conversation",
        title: "Conversation",
        explanation: "",
        conversationThread,
      },
    ];
  });
}

/** The unpublished pending-review comments as diff annotations. */
export function buildPendingReviewAnnotations(
  model: Pick<WorkbenchResponse, "pendingReview">,
): ReadonlyArray<ReviewInlineAnnotation> {
  const pendingReview = model.pendingReview;
  const review =
    pendingReview?.state === "pending" ||
    pendingReview?.state === "recovery_required"
      ? pendingReview.review
      : null;
  if (review === null) return [];
  return review.comments.flatMap((comment) => {
    const parsedThreadId = parseGitHubThreadId(comment.threadId);
    if (parsedThreadId._tag === "err") return [];
    return [
      {
        id: `pending-review:${comment.threadId}`,
        path: comment.path,
        start: comment.startLine,
        end: comment.line,
        side: comment.side,
        severity: "conversation",
        title: "Pending review",
        explanation: "",
        pendingReviewThread: {
          threadId: parsedThreadId.value,
          body: comment.body,
          nodeId: review.nodeId,
        },
      },
    ];
  });
}

/** Every inline annotation the diff renders: findings, then conversation threads. */
export function buildAnnotations(
  findings: ReadonlyArray<MappedFinding>,
  conversationThreadEntries: ReadonlyArray<ReviewInlineAnnotation>,
): ReadonlyArray<ReviewInlineAnnotation> {
  return [
    ...findings.flatMap((finding) =>
      finding.file === undefined ||
      finding.lineStart === undefined ||
      finding.diffSide === undefined
        ? []
        : [
            {
              id: finding.id,
              path: finding.file,
              start: finding.lineStart,
              end: finding.lineEnd ?? finding.lineStart,
              side: finding.diffSide,
              severity: finding.severity,
              title: finding.title,
              explanation: finding.explanation,
            },
          ],
    ),
    ...conversationThreadEntries,
  ];
}

/** Keeps the annotations whose head-side lines appear in a narrower patch; old-side numbers belong to the pull request base, so they cannot be placed. */
export function annotationsInPatch(
  annotations: ReadonlyArray<ReviewInlineAnnotation>,
  patch: string,
): ReadonlyArray<ReviewInlineAnnotation> {
  const files = parseUnifiedPatch(patch);
  return annotations.filter(
    (annotation) =>
      annotation.side === "new" &&
      mapFindingLocation(files, {
        file: annotation.path,
        lineStart: annotation.start,
        lineEnd: annotation.end,
        diffSide: "new",
      }).mappingStatus === "mapped",
  );
}
