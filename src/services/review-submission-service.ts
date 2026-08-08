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

type ReviewGateway = Pick<GitHubReader, "getPullRequest"> & Partial<Pick<GitHubReader, "getPullRequestComments">> & GitHubReviewWriter;

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
  | { readonly _tag: "GitHubSubmitFailed"; readonly session: ReviewSession; readonly batch: ReviewBatch }
  | { readonly _tag: "BatchOutcomeUnknown"; readonly session: ReviewSession; readonly batch: ReviewBatch };

/** Submits the one pending review already created from this persisted batch. */
export async function submitReviewBatch(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly session: ReviewSession;
  readonly batch: ReviewBatch;
  readonly event: GitHubReviewEvent;
  readonly gateway: ReviewGateway;
  readonly now: IsoTimestamp;
  /** Persist the in-progress marker before crossing the submit write boundary. */
  readonly persist: (session: ReviewSession) => Promise<boolean>;
}): Promise<Result<{ readonly session: ReviewSession; readonly batch: ReviewBatch }, BatchSubmitFailure>> {
  if (!isReviewEvent(input.event) || input.batch.summaryBody.trim().length === 0)
    return err({ _tag: "InvalidSubmitReview" });
  if (input.session.submittedReview !== undefined) return err({ _tag: "ReviewAlreadySubmitted" });
  if (input.batch.state._tag === "Applying" || (input.batch.state._tag === "PartialFailure" && (input.batch.state.failure.category === "outcome_unknown" || input.batch.state.failure.category === "unavailable"))) {
    return err({ _tag: "BatchOutcomeUnknown", session: input.session, batch: input.batch });
  }
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

  const operation: Extract<BatchOperation, { readonly _tag: "SubmitPendingReview" }> = {
    _tag: "SubmitPendingReview",
    reviewId: input.batch.state.reviewId,
    event: input.event,
  };
  const inProgressBatch: ReviewBatch = {
    ...input.batch,
    state: { _tag: "Applying", operation },
    updatedAt: input.now,
  };
  const inProgressSession: ReviewSession = {
    ...input.session,
    batch: { state: inProgressBatch.state },
    batchContent: inProgressBatch,
    updatedAt: input.now,
  };
  // Persist before submitPendingReview. If the call times out, recovery sees
  // this durable marker and cannot submit the same pending review again.
  if (!(await input.persist(inProgressSession))) {
    return err({ _tag: "BatchOutcomeUnknown", session: input.session, batch: input.batch });
  }
  const beforeSubmit = await verifiedCurrentHead(input.profile, input.session, input.gateway);
  if (beforeSubmit._tag === "err" || beforeSubmit.value !== input.session.key.headSha) {
    const blocked = staleWriteState(input.session, inProgressBatch, beforeSubmit._tag === "ok" ? beforeSubmit.value : undefined, input.now);
    if (!(await input.persist(blocked.session))) return err({ _tag: "BatchOutcomeUnknown", session: inProgressSession, batch: inProgressBatch });
    return err({ _tag: "StaleHeadBlocksWrite", session: blocked.session, batch: blocked.batch });
  }
  const submitted = await input.gateway.submitPendingReview({
    profile: input.profile,
    pr: sessionPr(input.session),
    reviewId: operation.reviewId,
    event: input.event,
    summaryBody: renderReviewBatchBody(input.batch),
  });
  if (submitted._tag === "err") {
    if (submitted.error.category === "unavailable") {
      return err({ _tag: "BatchOutcomeUnknown", session: inProgressSession, batch: inProgressBatch });
    }
    const failedBatch: ReviewBatch = {
      ...inProgressBatch,
      state: {
        _tag: "PartialFailure",
        operation,
        failure: { _tag: "SafeWriteFailure", category: submitted.error.category, message: submitted.error.message },
      },
      updatedAt: input.now,
    };
    const failedSession: ReviewSession = {
      ...inProgressSession,
      batch: { state: failedBatch.state },
      batchContent: failedBatch,
      updatedAt: input.now,
    };
    if (!(await input.persist(failedSession))) return err({ _tag: "BatchOutcomeUnknown", session: inProgressSession, batch: inProgressBatch });
    return err({ _tag: "GitHubSubmitFailed", session: failedSession, batch: failedBatch });
  }

  const batch: ReviewBatch = {
    ...inProgressBatch,
    state: { _tag: "Submitted", reviewId: submitted.value.reviewId, event: input.event },
    summaryBody: renderReviewBatchBody(input.batch),
    suggestedEvent: input.event,
    updatedAt: input.now,
  };
  const submittedSession: ReviewSession = {
    ...input.session,
    batch: { state: batch.state },
    batchContent: batch,
    submittedReview: { reviewId: submitted.value.reviewId, event: input.event, submittedAt: input.now },
    updatedAt: input.now,
  };
  // The submit mutation is also a remote write boundary. Do not return a
  // successful result until its durable outcome is saved.
  if (!(await input.persist(submittedSession))) {
    const failedBatch: ReviewBatch = {
      ...inProgressBatch,
      state: {
        _tag: "PartialFailure",
        operation,
        failure: { _tag: "SafeWriteFailure", category: "outcome_unknown", message: "The successful GitHub submission could not be persisted." },
      },
      updatedAt: input.now,
    };
    const failedSession: ReviewSession = {
      ...inProgressSession,
      batch: { state: failedBatch.state },
      batchContent: failedBatch,
      updatedAt: input.now,
    };
    await input.persist(failedSession);
    return err({ _tag: "BatchOutcomeUnknown", session: failedSession, batch: failedBatch });
  }
  return ok({ batch, session: submittedSession });
}

/** Plans the persisted, confirmed remote operations in their only legal order. */
export function planBatchOperations(
  batch: ReviewBatch,
  options: { readonly allowInline?: boolean } = {},
): ReadonlyArray<BatchOperation> {
  // Planning is intentionally empty while a remote outcome is unresolved.
  // This is a second line of defence for callers that plan before applying.
  if (batch.state._tag === "Applying" || (batch.state._tag === "PartialFailure" && (batch.state.failure.category === "outcome_unknown" || batch.state.failure.category === "unavailable"))) return [];
  if (hasIncludedNeedsAttention(batch)) {
    throw new Error("Included review items need attention before posting.");
  }
  const allowInline = options.allowInline ?? true;
  const inline = batch.items.filter((item): item is Extract<ReviewBatchItem, { readonly _tag: "InlineComment" }> => item._tag === "InlineComment" && allowInline && item.include && item.postability === "postable" && !hasReceiptForItem(batch, item.id));
  const thread = batch.items.filter((item) => item.include && (item._tag === "ThreadReply" || item._tag === "ThreadState") && !hasReceiptForItem(batch, item.id));
  const hasPendingReceipt = batch.receipts.some((receipt) => receipt._tag === "PendingReviewCreated");
  const createBodyReview = inline.length === 0 && !hasPendingReceipt && batch.summaryBody.trim().length > 0;
  return [
    ...(inline.length === 0 && !createBodyReview ? [] : [{ _tag: "CreatePendingReview" as const, itemIds: inline.map((item) => item.id) }]),
    ...thread.map((item) => item._tag === "ThreadReply" ? ({ _tag: "Reply" as const, itemId: item.id }) : ({ _tag: "ThreadState" as const, itemId: item.id })),
  ];
}

export type BatchApplyFailure = { readonly _tag: "StaleHeadBlocksWrite" | "BatchOutcomeUnknown" | "BatchWriteRejected" | "BatchWriterUnavailable" | "NeedsAttentionBlocksWrite"; readonly session: ReviewSession; readonly batch: ReviewBatch };

/** Applies one confirmed batch, durably recording the state before every remote operation. */
export async function applyReviewBatch(input: {
  readonly profile: WorkspaceProfileConfig; readonly session: ReviewSession; readonly batch: ReviewBatch; readonly gateway: ReviewGateway;
  readonly now: IsoTimestamp; readonly persist: (session: ReviewSession) => Promise<boolean>;
}): Promise<Result<{ readonly session: ReviewSession; readonly batch: ReviewBatch }, BatchApplyFailure>> {
  // An Applying operation has already crossed the remote-write boundary. An
  // outcome-unknown failure carries the same lock. Neither may be planned or
  // replayed until a read-side reconciliation records a receipt.
  if (input.batch.state._tag === "Applying" || (input.batch.state._tag === "PartialFailure" && (input.batch.state.failure.category === "outcome_unknown" || input.batch.state.failure.category === "unavailable"))) {
    return err({ _tag: "BatchOutcomeUnknown", session: input.session, batch: input.batch });
  }
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
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const plannedOperation = operations[operationIndex];
    if (plannedOperation === undefined) break;
    // Reply reconciliation needs an operation-specific durable boundary. The
    // marker is persisted before the remote call, so an older identical reply
    // cannot be mistaken for this write after a timeout.
    let operation: BatchOperation = plannedOperation;
    if (plannedOperation._tag === "Reply") {
      // Capture the thread's pre-write comment IDs before persisting the
      // operation marker. Recovery can then prove that a matching comment is
      // new for this operation, rather than merely looking like one.
      let priorCommentIds: ReadonlyArray<string> | undefined;
      if (input.gateway.getPullRequestComments !== undefined) {
        const observed = await input.gateway.getPullRequestComments({ profile: input.profile, pr: sessionPr(session) });
        if (observed._tag === "ok" && observed.value.complete !== false) {
          const thread = observed.value.threads.find((candidate) => candidate.id === itemIdForOperation(batch, plannedOperation));
          priorCommentIds = thread?.comments.map((comment) => comment.id);
        }
      }
      operation = { ...plannedOperation, startedAt: input.now, ...(priorCommentIds === undefined ? {} : { priorCommentIds }) };
    }
    batch = { ...batch, state: { _tag: "Applying", operation }, updatedAt: input.now };
    session = { ...session, batch: { state: batch.state }, batchContent: batch, updatedAt: input.now };
    if (!(await input.persist(session))) return err({ _tag: "BatchOutcomeUnknown", session, batch });
    const beforeWrite = await verifiedCurrentHead(input.profile, session, input.gateway);
    if (beforeWrite._tag === "err" || beforeWrite.value !== session.key.headSha) {
      const blocked = staleWriteState(session, batch, beforeWrite._tag === "ok" ? beforeWrite.value : undefined, input.now);
      if (!(await input.persist(blocked.session))) return err({ _tag: "BatchOutcomeUnknown", session, batch });
      return err({ _tag: "StaleHeadBlocksWrite", session: blocked.session, batch: blocked.batch });
    }
    const item = operation._tag === "CreatePendingReview" || operation._tag === "SubmitPendingReview" ? undefined : batch.items.find((value) => value.id === operation.itemId);
    let receipt: ReviewBatch["receipts"][number] | undefined;
    if (operation._tag === "CreatePendingReview") {
      const comments = batch.items.filter((value): value is Extract<ReviewBatchItem, { readonly _tag: "InlineComment" }> => value._tag === "InlineComment" && operation.itemIds.includes(value.id)).map((value) => ({ body: value.body, path: value.anchor.path, line: value.anchor.startLine, ...(value.anchor.startLine === value.anchor.line ? {} : { lineEnd: value.anchor.line }), diffSide: value.anchor.side }));
      const created = await input.gateway.createPendingReview({ profile: input.profile, pr: sessionPr(session), headSha: session.key.headSha, summaryBody: renderReviewBatchBody(batch), comments });
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
    const receiptedBatch: ReviewBatch = {
      ...batch,
      receipts: [...batch.receipts, receipt],
      updatedAt: input.now,
    };
    // A receipt is the durable proof that the remote mutation completed. Save
    // it before attempting any later operation; otherwise a crash can replay
    // an already-successful write. Keep the batch in a stable state while the
    // next operation is not yet marked Applying.
    // If another operation remains, persist its intent together with this
    // receipt. That keeps the durable batch schema's ordered-prefix invariant
    // while ensuring a crash cannot lose the completed operation.
    const nextPlannedOperation = operations[operationIndex + 1];
    let nextOperation = nextPlannedOperation;
    if (nextPlannedOperation?._tag === "Reply") {
      let priorCommentIds: ReadonlyArray<string> | undefined;
      if (input.gateway.getPullRequestComments !== undefined) {
        const observed = await input.gateway.getPullRequestComments({ profile: input.profile, pr: sessionPr(session) });
        if (observed._tag === "ok" && observed.value.complete !== false) {
          const thread = observed.value.threads.find((candidate) => candidate.id === itemIdForOperation(receiptedBatch, nextPlannedOperation));
          priorCommentIds = thread?.comments.map((comment) => comment.id);
        }
      }
      nextOperation = { ...nextPlannedOperation, startedAt: input.now, ...(priorCommentIds === undefined ? {} : { priorCommentIds }) };
    }
    const receiptedState = receiptedBatch.receipts.some((value) => value._tag === "PendingReviewCreated")
      ? stateAfterReceipt(receiptedBatch)
      : nextOperation === undefined
        ? stateAfterReceipt(receiptedBatch)
        : { _tag: "Applying" as const, operation: nextOperation };
    const receiptedSession: ReviewSession = {
      ...session,
      batch: { state: receiptedState },
      batchContent: { ...receiptedBatch, state: receiptedState },
      updatedAt: input.now,
    };
    const durableBatch = { ...receiptedBatch, state: receiptedState };
    if (!(await input.persist(receiptedSession))) {
      return err(await persistBatchFailure({
        operation,
        category: "unavailable",
        message: "The successful GitHub operation receipt could not be persisted.",
        session,
        batch,
        now: input.now,
        persist: input.persist,
      }));
    }
    batch = durableBatch;
    session = receiptedSession;
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

export function renderReviewBatchBody(batch: ReviewBatch): string {
  const summary = batch.summaryBody.trim();
  const general = batch.items
    .filter((item): item is Extract<ReviewBatchItem, { readonly _tag: "GeneralComment" }> => item._tag === "GeneralComment" && item.include)
    .map((item) => item.body.trim())
    .filter((body) => body.length > 0);
  return general.length === 0
    ? summary
    : [summary, "## Additional feedback", ...general.map((body) => `- ${body}`)].filter((section) => section.length > 0).join("\\n\\n");
}

function itemIdForOperation(batch: ReviewBatch, operation: Extract<BatchOperation, { readonly _tag: "Reply" }>): string {
  const item = batch.items.find((candidate) => candidate.id === operation.itemId);
  return item?._tag === "ThreadReply" ? item.threadId : "";
}

function stateAfterReceipt(batch: ReviewBatch): ReviewBatch["state"] {
  const pending = batch.receipts.find((receipt): receipt is Extract<ReviewBatch["receipts"][number], { readonly _tag: "PendingReviewCreated" }> => receipt._tag === "PendingReviewCreated");
  const planned = planBatchOperations({ ...batch, state: { _tag: "Local" } });
  const remaining = planned.some((operation) => !hasReceiptForPlannedOperation(batch, operation));
  if (remaining) return pending === undefined ? { _tag: "Local" } : { _tag: "PendingReview", reviewId: pending.reviewId };
  return pending === undefined ? { _tag: "Completed" } : { _tag: "PendingReview", reviewId: pending.reviewId };
}

/** Every unresolved anchor blocks a remote write, including excluded items.
 * Exclusion changes publication content, not whether the local anchor is safe. */
export function hasNeedsAttention(batch: Pick<ReviewBatch, "items">): boolean {
  return batch.items.some(
    (item) => item._tag === "InlineComment" && item.postability === "needs_attention",
  );
}

function hasIncludedNeedsAttention(batch: ReviewBatch): boolean {
  return hasNeedsAttention(batch);
}

function hasReceiptForItem(batch: ReviewBatch, itemId: ReviewBatchItem["id"]): boolean {
  return batch.receipts.some((receipt) => receipt._tag === "PendingReviewCreated"
    ? receipt.itemIds.includes(itemId)
    : receipt.itemId === itemId);
}

function hasReceiptForPlannedOperation(batch: ReviewBatch, operation: BatchOperation): boolean {
  if (operation._tag === "CreatePendingReview") {
    return batch.receipts.some((receipt) => receipt._tag === "PendingReviewCreated"
      && receipt.itemIds.length === operation.itemIds.length
      && operation.itemIds.every((itemId) => receipt.itemIds.includes(itemId)));
  }
  if (operation._tag === "SubmitPendingReview") return false;
  return batch.receipts.some((receipt) => receipt._tag !== "PendingReviewCreated" && receipt.itemId === operation.itemId);
}

function staleWriteState(
  session: ReviewSession,
  batch: ReviewBatch,
  currentHeadSha: GitSha | undefined,
  now: IsoTimestamp,
): { readonly session: ReviewSession; readonly batch: ReviewBatch } {
  const pending = batch.receipts.find((receipt): receipt is Extract<ReviewBatch["receipts"][number], { readonly _tag: "PendingReviewCreated" }> => receipt._tag === "PendingReviewCreated");
  const staleBatch = {
    ...batch,
    items: batch.items.map((item) => item._tag === "InlineComment" && item.include && item.postability === "postable"
      ? { ...item, postability: "stale_sha" as const }
      : item),
    state: pending === undefined ? { _tag: "Local" as const } : { _tag: "PendingReview" as const, reviewId: pending.reviewId },
    updatedAt: now,
  };
  return {
    batch: staleBatch,
    session: {
      ...session,
      state: { _tag: "Stale", reason: "head_changed", ...(currentHeadSha === undefined ? {} : { currentHeadSha }) },
      batch: { state: staleBatch.state },
      batchContent: staleBatch,
      updatedAt: now,
    },
  };
}

async function persistBatchFailure(input: {
  readonly operation: BatchOperation;
  readonly category: "auth" | "rejected" | "unavailable" | "pending_review";
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
        category: input.category === "unavailable" ? "outcome_unknown" : input.category,
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
