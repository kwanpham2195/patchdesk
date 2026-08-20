import type { ReviewInlineAnnotation } from "./components/review-diff-view";

/**
 * Merges published Conversation thread annotations with pending-review reply
 * annotations into the entry list the diff (and, eventually, a Threads
 * navigator section) consumes. A published thread that also has a pending
 * reply is deduped to its pending entry — the pending card is the
 * authoritative view for the review owner — so each Conversation thread
 * renders exactly once.
 */
export function deriveConversationThreadEntries(
  published: ReadonlyArray<ReviewInlineAnnotation>,
  pending: ReadonlyArray<ReviewInlineAnnotation>,
): ReadonlyArray<ReviewInlineAnnotation> {
  const pendingThreadIds = new Set(
    pending.flatMap((annotation) =>
      annotation.pendingReviewThread === undefined
        ? []
        : [annotation.pendingReviewThread.threadId],
    ),
  );
  const publishedEntries = published.flatMap(
    (annotation): ReadonlyArray<ReviewInlineAnnotation> =>
      annotation.conversationThread?.target._tag === "thread" &&
      pendingThreadIds.has(annotation.conversationThread.target.id)
        ? []
        : [annotation],
  );
  return [...publishedEntries, ...pending];
}
