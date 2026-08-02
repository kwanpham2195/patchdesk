import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { BatchOperation, GitHubReviewEvent, ReviewBatch, ReviewBatchItem } from "../domain/review-batch";
import type { GitSha, IsoTimestamp } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";

type ReviewGateway = Pick<GitHubReader, "getPullRequest"> & GitHubReviewWriter;

async function verifiedCurrentHead(
  profile: WorkspaceProfileConfig,
  session: ReviewSession,
  gateway: ReviewGateway,
): Promise<Result<GitSha, { readonly _tag: "GitHubHeadReadFailed" }>> {
  const current = await gateway.getPullRequest({ profile, pr: sessionPr(session) });
  return current._tag === "err"
    ? err({ _tag: "GitHubHeadReadFailed" })
    : ok(current.value.headSha);
}

function isReviewEvent(value: unknown): value is GitHubReviewEvent {
  return value === "APPROVE" || value === "COMMENT" || value === "REQUEST_CHANGES";
}

function sessionPr(session: ReviewSession): PullRequestRef {
  return { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber };
}

export type BatchSubmitFailure =
  | { readonly _tag: "InvalidSubmitReview" }
  | { readonly _tag: "PendingReviewRequired" }
  | { readonly _tag: "ReviewAlreadySubmitted" }
  | { readonly _tag: "NeedsAttentionBlocksWrite" }
  | { readonly _tag: "GitHubHeadReadFailed" }
  | { readonly _tag: "StaleHeadBlocksWrite"; readonly session: ReviewSession; readonly batch: ReviewBatch }
  | { readonly _tag: "GitHubSubmitFailed"; readonly session: ReviewSession; readonly batch: ReviewBatch };

/** Submits the one pending review already created from this persisted batch. */
export async function submitReviewBatch(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly session: ReviewSession;
  readonly batch: ReviewBatch;
  readonly event: GitHubReviewEvent;
  readonly gateway: ReviewGateway;
  readonly now: IsoTimestamp;
}): Promise<Result<{ readonly session: ReviewSession; readonly batch: ReviewBatch }, BatchSubmitFailure>> {
  if (!isReviewEvent(input.event) || input.batch.summaryBody.trim().length === 0)
    return err({ _tag: "InvalidSubmitReview" });
  if (input.session.submittedReview !== undefined) return err({ _tag: "ReviewAlreadySubmitted" });
  if (input.batch.state._tag !== "PendingReview") return err({ _tag: "PendingReviewRequired" });
  if (hasIncludedNeedsAttention(input.batch)) return err({ _tag: "NeedsAttentionBlocksWrite" });

  const currentHead = await verifiedCurrentHead(input.profile, input.session, input.gateway);
  if (currentHead._tag === "err") return currentHead;
  if (input.session.key.headSha !== currentHead.value || input.session.state._tag === "Stale") {
    return err({
      _tag: "StaleHeadBlocksWrite",
      batch: input.batch,
      session: {
        ...input.session,
        state: { _tag: "Stale", reason: "head_changed", currentHeadSha: currentHead.value },
        updatedAt: input.now,
      },
    });
  }

  // No await occurs between the verified head comparison above and this explicit submit call.
  const submitted = await input.gateway.submitPendingReview({
    profile: input.profile,
    pr: sessionPr(input.session),
    reviewId: input.batch.state.reviewId,
    event: input.event,
    summaryBody: input.batch.summaryBody.trim(),
  });
  if (submitted._tag === "err")
    return err({ _tag: "GitHubSubmitFailed", session: input.session, batch: input.batch });

  const batch: ReviewBatch = {
    ...input.batch,
    state: { _tag: "Submitted", reviewId: submitted.value.reviewId, event: input.event },
    summaryBody: input.batch.summaryBody.trim(),
    suggestedEvent: input.event,
    updatedAt: input.now,
  };
  return ok({
    batch,
    session: {
      ...input.session,
      batch: { state: batch.state },
      batchContent: batch,
      submittedReview: { reviewId: submitted.value.reviewId, event: input.event, submittedAt: input.now },
      updatedAt: input.now,
    },
  });
}

/** Plans the persisted, confirmed remote operations in their only legal order. */
export function planBatchOperations(
  batch: ReviewBatch,
  options: { readonly allowInline?: boolean } = {},
): ReadonlyArray<BatchOperation> {
  if (hasIncludedNeedsAttention(batch)) {
    throw new Error("Included review items need attention before posting.");
  }
  const allowInline = options.allowInline ?? true;
  const inline = batch.items.filter((item): item is Extract<ReviewBatchItem, { readonly _tag: "InlineComment" }> => item._tag === "InlineComment" && allowInline && item.include && item.postability === "postable" && !hasReceiptForItem(batch, item.id));
  const thread = batch.items.filter((item) => item.include && (item._tag === "ThreadReply" || item._tag === "ThreadState") && !hasReceiptForItem(batch, item.id));
  return [
    ...(inline.length === 0 ? [] : [{ _tag: "CreatePendingReview" as const, itemIds: inline.map((item) => item.id) }]),
    ...thread.map((item) => item._tag === "ThreadReply" ? ({ _tag: "Reply" as const, itemId: item.id }) : ({ _tag: "ThreadState" as const, itemId: item.id })),
  ];
}

export type BatchApplyFailure = { readonly _tag: "StaleHeadBlocksWrite" | "BatchOutcomeUnknown" | "BatchWriteRejected" | "BatchWriterUnavailable" | "NeedsAttentionBlocksWrite"; readonly session: ReviewSession; readonly batch: ReviewBatch };

/** Applies one confirmed batch, durably recording the state before every remote operation. */
export async function applyReviewBatch(input: {
  readonly profile: WorkspaceProfileConfig; readonly session: ReviewSession; readonly batch: ReviewBatch; readonly gateway: ReviewGateway;
  readonly now: IsoTimestamp; readonly persist: (session: ReviewSession) => Promise<boolean>;
}): Promise<Result<{ readonly session: ReviewSession; readonly batch: ReviewBatch }, BatchApplyFailure>> {
  const current = await verifiedCurrentHead(input.profile, input.session, input.gateway);
  const isFresh = current._tag === "ok" && current.value === input.session.key.headSha;
  let batch = input.batch;
  let session = input.session;
  if (!isFresh) {
    batch = {
      ...batch,
      items: batch.items.map((item) => item._tag === "InlineComment" && item.include && item.postability === "postable"
        ? { ...item, postability: "stale_sha" as const }
        : item),
      updatedAt: input.now,
    };
    session = {
      ...session,
      state: { _tag: "Stale", reason: "head_changed", ...(current._tag === "ok" ? { currentHeadSha: current.value } : {}) },
      batch: { state: batch.state },
      batchContent: batch,
      updatedAt: input.now,
    };
  }
  if (current._tag === "err") {
    return err({ _tag: "StaleHeadBlocksWrite", session, batch });
  }
  if (hasIncludedNeedsAttention(batch)) {
    return err({ _tag: "NeedsAttentionBlocksWrite", session, batch });
  }
  const operations = planBatchOperations(batch, { allowInline: isFresh });
  if (operations.length === 0 && !isFresh) {
    return err({ _tag: "StaleHeadBlocksWrite", session, batch });
  }
  if (!isFresh && !(await input.persist(session))) {
    return err({ _tag: "BatchOutcomeUnknown", session, batch });
  }
  for (const operation of operations) {
    batch = { ...batch, state: { _tag: "Applying", operation }, updatedAt: input.now };
    session = { ...session, batch: { state: batch.state }, batchContent: batch, updatedAt: input.now };
    if (!(await input.persist(session))) return err({ _tag: "BatchOutcomeUnknown", session, batch });
    const item = operation._tag === "CreatePendingReview" ? undefined : batch.items.find((value) => value.id === operation.itemId);
    let receipt: ReviewBatch["receipts"][number] | undefined;
    if (operation._tag === "CreatePendingReview") {
      const comments = batch.items.filter((value): value is Extract<ReviewBatchItem, { readonly _tag: "InlineComment" }> => value._tag === "InlineComment" && operation.itemIds.includes(value.id)).map((value) => ({ body: value.body, path: value.anchor.path, line: value.anchor.startLine, ...(value.anchor.startLine === value.anchor.line ? {} : { lineEnd: value.anchor.line }), diffSide: value.anchor.side }));
      const created = await input.gateway.createPendingReview({ profile: input.profile, pr: sessionPr(session), headSha: session.key.headSha, summaryBody: batch.summaryBody, comments });
      if (created._tag === "err") return err(await persistBatchFailure({
        operation,
        category: created.error.category,
        message: created.error.message,
        session,
        batch,
        now: input.now,
        persist: input.persist,
      }));
      receipt = { _tag: "PendingReviewCreated", reviewId: created.value.reviewId, itemIds: operation.itemIds };
    } else if (operation._tag === "Reply" && item?._tag === "ThreadReply" && input.gateway.createThreadReply !== undefined) {
      const replied = await input.gateway.createThreadReply({ profile: input.profile, threadId: item.threadId, body: item.body });
      if (replied._tag === "err") return err(await persistBatchFailure({
        operation,
        category: replied.error.category,
        message: replied.error.message,
        session,
        batch,
        now: input.now,
        persist: input.persist,
      }));
      receipt = { _tag: "ReplyCreated", itemId: item.id, commentId: replied.value.commentId };
    } else if (operation._tag === "ThreadState" && item?._tag === "ThreadState" && input.gateway.setReviewThreadState !== undefined) {
      const changed = await input.gateway.setReviewThreadState({ profile: input.profile, threadId: item.threadId, state: item.action === "resolve" ? "resolved" : "open" });
      if (changed._tag === "err") return err(await persistBatchFailure({
        operation,
        category: changed.error.category,
        message: changed.error.message,
        session,
        batch,
        now: input.now,
        persist: input.persist,
      }));
      receipt = { _tag: "ThreadStateChanged", itemId: item.id, state: item.action === "resolve" ? "resolved" : "open" };
    } else return err(await persistBatchFailure({
      operation,
      category: "unavailable",
      message: "GitHub thread writes are unavailable for this profile.",
      session,
      batch,
      now: input.now,
      persist: input.persist,
    }));
    batch = { ...batch, receipts: [...batch.receipts, receipt], updatedAt: input.now };
  }
  const pending = batch.receipts.find((receipt): receipt is Extract<ReviewBatch["receipts"][number], { readonly _tag: "PendingReviewCreated" }> => receipt._tag === "PendingReviewCreated");
  const pendingInline = batch.items.some((item) => item._tag === "InlineComment" && item.include && (item.postability === "postable" || item.postability === "stale_sha") && !hasReceiptForItem(batch, item.id));
  batch = {
    ...batch,
    state: pendingInline ? { _tag: "Local" } : pending === undefined ? { _tag: "Completed" } : { _tag: "PendingReview", reviewId: pending.reviewId },
    updatedAt: input.now,
  };
  session = { ...session, batch: { state: batch.state }, batchContent: batch, updatedAt: input.now };
  return (await input.persist(session)) ? ok({ session, batch }) : err({ _tag: "BatchOutcomeUnknown", session, batch });
}

function hasIncludedNeedsAttention(batch: ReviewBatch): boolean {
  return batch.items.some(
    (item) => item._tag === "InlineComment" && item.include && item.postability === "needs_attention",
  );
}

function hasReceiptForItem(batch: ReviewBatch, itemId: ReviewBatchItem["id"]): boolean {
  return batch.receipts.some((receipt) => receipt._tag === "PendingReviewCreated"
    ? receipt.itemIds.includes(itemId)
    : receipt.itemId === itemId);
}

async function persistBatchFailure(input: {
  readonly operation: BatchOperation;
  readonly category: "auth" | "rejected" | "unavailable";
  readonly message: string;
  readonly session: ReviewSession;
  readonly batch: ReviewBatch;
  readonly now: IsoTimestamp;
  readonly persist: (session: ReviewSession) => Promise<boolean>;
}): Promise<BatchApplyFailure> {
  const failedBatch: ReviewBatch = {
    ...input.batch,
    state: {
      _tag: "PartialFailure",
      operation: input.operation,
      failure: {
        _tag: "SafeWriteFailure",
        category: input.category,
        message: input.message,
      },
    },
    updatedAt: input.now,
  };
  const failedSession: ReviewSession = {
    ...input.session,
    batch: { state: failedBatch.state },
    batchContent: failedBatch,
    updatedAt: input.now,
  };
  if (!(await input.persist(failedSession))) {
    return { _tag: "BatchOutcomeUnknown", session: input.session, batch: input.batch };
  }
  return {
    _tag: input.category === "rejected" ? "BatchWriteRejected" : "BatchOutcomeUnknown",
    session: failedSession,
    batch: failedBatch,
  };
}
