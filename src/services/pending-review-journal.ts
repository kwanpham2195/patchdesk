import type {
  PendingReviewOperation,
  PendingReviewState,
  PendingReviewThreadWrite,
  ViewerPendingReview,
} from "../domain/pending-review";
import type { RecentReviewWrite } from "../domain/recent-review-write";

/**
 * The typed own-write journal entries one confirmed pending-review write
 * proves. Start/AddThread journal the thread the adapter reports it created
 * (`createdThreadId`, never guessed locally) as `PendingThread`, which an
 * observation satisfies by finding it. A confirmed Discard that resolved to
 * `None` journals each thread the pre-operation Pending draft held as
 * `DiscardedThread`, satisfied by its absence, mirroring the renderer's
 * `threadIdsOf()` derivation. Submit is intentionally not journaled: no
 * `RecentReviewWrite` variant represents "pending threads became a published
 * review".
 */
export function journalEntriesFor(
  operation: PendingReviewOperation,
  priorState: PendingReviewState,
  written: PendingReviewThreadWrite | ViewerPendingReview | undefined,
  confirmed: PendingReviewState,
): ReadonlyArray<RecentReviewWrite> {
  if (
    (operation._tag === "Start" || operation._tag === "AddThread") &&
    written !== undefined &&
    "createdThreadId" in written
  ) {
    return [
      {
        _tag: "PendingThread",
        threadId: written.createdThreadId,
        pendingReviewNodeId: written.review.nodeId,
      },
    ];
  }
  if (
    operation._tag === "Discard" &&
    confirmed._tag === "None" &&
    priorState._tag === "Pending"
  ) {
    return priorState.review.comments.map((comment) => ({
      _tag: "DiscardedThread" as const,
      threadId: comment.threadId,
    }));
  }
  return [];
}
