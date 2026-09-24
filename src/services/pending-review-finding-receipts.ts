import type {
  FindingReviewReceipt,
  FindingReviewSource,
  PendingReviewRead,
  PendingReviewState,
  PendingReviewThreadWrite,
  ViewerPendingReview,
} from "../domain/pending-review";
import type { GitHubReviewNodeId } from "../domain/ids";
import type {
  GitHubComments,
  GitHubPublishedFeedback,
} from "../domain/github-context";

/**
 * Finding-receipt policy for the pending-review lifecycle: which durable
 * receipts one write produces, and what an observation may conclude about the
 * ones already stored. `PendingReviewService` owns the write sequence and the
 * session; this module owns only the receipt arithmetic it hands over.
 */

/** Whether two Analysis Findings are the same authorization. */
export function sameFindingSource(
  left: FindingReviewSource,
  right: FindingReviewSource | undefined,
): boolean {
  return (
    right !== undefined &&
    left.analysisRunId === right.analysisRunId &&
    left.findingId === right.findingId &&
    left.sessionId === right.sessionId &&
    left.headSha === right.headSha &&
    left.patchHash === right.patchHash
  );
}

/** Whether a Finding already owns a stored receipt, in any state. */
export function hasFindingReceipt(
  receipts: ReadonlyArray<FindingReviewReceipt> | undefined,
  finding: FindingReviewSource,
): boolean {
  return (receipts ?? []).some(
    (receipt) =>
      receipt.analysisRunId === finding.analysisRunId &&
      receipt.findingId === finding.findingId &&
      receipt.sessionId === finding.sessionId &&
      receipt.headSha === finding.headSha &&
      receipt.patchHash === finding.patchHash,
  );
}

export function reconcileObservedFindingReceipts(input: {
  readonly receipts: ReadonlyArray<FindingReviewReceipt> | undefined;
  readonly pendingReview: PendingReviewState;
  readonly evidenceComplete: boolean;
  readonly comments: GitHubComments;
  readonly publishedFeedback?: GitHubPublishedFeedback;
}): ReadonlyArray<FindingReviewReceipt> {
  const receipts = input.receipts ?? [];
  if (!input.evidenceComplete) {
    return receipts.map((receipt) =>
      receipt.state === "pending"
        ? { ...receipt, state: "historical" as const }
        : receipt,
    );
  }
  const remoteThreadIds = new Set(
    input.comments.threads.map((thread) => thread.id),
  );
  const publishedIds = new Set<string>();
  for (const comment of input.publishedFeedback?.comments ?? []) {
    publishedIds.add(comment.id);
    if (comment.nodeId !== undefined) publishedIds.add(comment.nodeId);
  }
  const next: FindingReviewReceipt[] = [];
  for (const receipt of receipts) {
    const remainsPending =
      input.pendingReview._tag === "Pending" &&
      input.pendingReview.review.nodeId === receipt.pendingReviewNodeId &&
      input.pendingReview.review.comments.some(
        (comment) => comment.threadId === receipt.threadId,
      );
    if (remainsPending) {
      next.push({ ...receipt, state: "pending" });
      continue;
    }
    // Complete Conversation and published-feedback evidence still needs to
    // contain the exact known receipt identifier before it can keep a Finding
    // non-actionable. Anything less stays Historical and cannot re-enable it.
    if (
      remoteThreadIds.has(receipt.threadId) ||
      publishedIds.has(receipt.threadId)
    ) {
      next.push({ ...receipt, state: "historical" });
    }
  }
  return next;
}

/** Thread evidence one Refresh read, used to tell a deleted pending review from a submitted one. */
export type FindingReceiptEvidence = {
  readonly comments: GitHubComments;
  readonly publishedFeedback?: GitHubPublishedFeedback;
};

export type ReleasedFindingReceipts = {
  readonly receipts: ReadonlyArray<FindingReviewReceipt>;
  readonly pendingReviewNodeIds: ReadonlyArray<GitHubReviewNodeId>;
  /** Receipts removed, so their Findings can be added again. */
  readonly cleared: number;
  /** Receipts whose thread GitHub now shows published, so their Findings stay non-actionable. */
  readonly published: number;
};

/**
 * Release pending receipts whose pending review GitHub confirmed is gone: it
 * reported no viewer pending review, or one with a different id. A receipt
 * whose thread the evidence shows is published was submitted elsewhere and
 * turns historical; every other one is removed. Incomplete thread evidence
 * cannot tell a deletion from a submission, so it changes nothing.
 */
export function releaseGoneFindingReceipts(input: {
  readonly receipts: ReadonlyArray<FindingReviewReceipt> | undefined;
  readonly observed: Exclude<
    PendingReviewRead,
    { readonly _tag: "Unavailable" }
  >;
  readonly evidence: FindingReceiptEvidence;
}): ReleasedFindingReceipts {
  const receipts = input.receipts ?? [];
  const liveNodeId =
    input.observed._tag === "Pending"
      ? input.observed.review.nodeId
      : undefined;
  const gone = (receipt: FindingReviewReceipt): boolean =>
    receipt.state === "pending" && receipt.pendingReviewNodeId !== liveNodeId;
  const evidenceComplete =
    input.evidence.comments.complete === true &&
    (input.evidence.publishedFeedback === undefined ||
      input.evidence.publishedFeedback.complete === true);
  if (!evidenceComplete || !receipts.some(gone))
    return { receipts, pendingReviewNodeIds: [], cleared: 0, published: 0 };
  const publishedThreadIds = new Set<string>(
    input.evidence.comments.threads.map((thread) => thread.id),
  );
  for (const comment of input.evidence.publishedFeedback?.comments ?? []) {
    publishedThreadIds.add(comment.id);
    if (comment.nodeId !== undefined) publishedThreadIds.add(comment.nodeId);
  }
  const next: FindingReviewReceipt[] = [];
  const nodeIds = new Set<GitHubReviewNodeId>();
  let published = 0;
  for (const receipt of receipts) {
    if (!gone(receipt)) {
      next.push(receipt);
      continue;
    }
    nodeIds.add(receipt.pendingReviewNodeId);
    if (publishedThreadIds.has(receipt.threadId)) {
      next.push({ ...receipt, state: "historical" });
      published += 1;
    }
  }
  return {
    receipts: next,
    pendingReviewNodeIds: [...nodeIds],
    cleared: receipts.length - next.length,
    published,
  };
}

export function nextFindingReceipts(
  existing: ReadonlyArray<FindingReviewReceipt> | undefined,
  begun: PendingReviewState,
  written: PendingReviewThreadWrite | ViewerPendingReview | undefined,
  confirmed: PendingReviewState,
): ReadonlyArray<FindingReviewReceipt> | undefined {
  const receipts = existing ?? [];
  if (begun._tag !== "WriteInFlight") return undefined;
  const operation = begun.operation;
  const finding =
    operation._tag === "Start" || operation._tag === "AddThread"
      ? operation.finding
      : undefined;
  if (finding !== undefined) {
    if (
      written === undefined ||
      !("createdThreadId" in written) ||
      confirmed._tag !== "Pending"
    )
      return undefined;
    if (
      finding.sessionId === "" ||
      finding.headSha !== confirmed.review.headSha ||
      hasFindingReceipt(receipts, finding)
    )
      return undefined;
    if (
      !confirmed.review.comments.some(
        (comment) => comment.threadId === written.createdThreadId,
      )
    )
      return undefined;
    return [
      ...receipts,
      {
        ...finding,
        threadId: written.createdThreadId,
        pendingReviewNodeId: confirmed.review.nodeId,
        state: "pending",
      },
    ];
  }
  if (operation._tag === "Submit" && begun.review !== undefined) {
    return receipts.map((receipt) =>
      receipt.state === "pending" &&
      receipt.pendingReviewNodeId === begun.review?.nodeId
        ? { ...receipt, state: "published" as const }
        : receipt,
    );
  }
  if (operation._tag === "Discard" && begun.review !== undefined) {
    return receipts.filter(
      (receipt) =>
        receipt.state !== "pending" ||
        receipt.pendingReviewNodeId !== begun.review?.nodeId,
    );
  }
  return receipts;
}
