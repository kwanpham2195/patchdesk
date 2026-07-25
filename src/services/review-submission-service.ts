import type {
  GitHubReader,
  GitHubReviewWriter,
  PendingReviewComment,
} from "../adapters/github/github-adapter";
import type { GitHubReviewEvent, ReviewDraft } from "../domain/review-draft";
import type { BatchOperation, ReviewBatch, ReviewBatchItem } from "../domain/review-batch";
import type { GitSha, IsoTimestamp } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";

type ReviewGateway = Pick<GitHubReader, "getPullRequest"> & GitHubReviewWriter;

export type ReviewSubmissionFailure =
  | { readonly _tag: "DraftNotCreatable" }
  | { readonly _tag: "NoPostableComments" }
  | { readonly _tag: "InvalidSubmitReview" }
  | { readonly _tag: "PendingReviewRequired" }
  | { readonly _tag: "ReviewAlreadySubmitted" }
  | { readonly _tag: "GitHubHeadReadFailed" }
  | { readonly _tag: "StaleHeadBlocksWrite"; readonly session: ReviewSession; readonly draft: ReviewDraft }
  | { readonly _tag: "GitHubWriteRejected"; readonly session: ReviewSession; readonly draft: ReviewDraft }
  | { readonly _tag: "GitHubCreateAmbiguous"; readonly session: ReviewSession; readonly draft: ReviewDraft }
  | { readonly _tag: "GitHubSubmitFailed"; readonly session: ReviewSession; readonly draft: ReviewDraft };

type SubmissionSuccess = { readonly session: ReviewSession; readonly draft: ReviewDraft };

/** Creates exactly one PENDING review after a final remote head check; callers persist every returned state. */
export async function createPendingReview(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly session: ReviewSession;
  readonly draft: ReviewDraft;
  readonly gateway: ReviewGateway;
  readonly now: IsoTimestamp;
}): Promise<Result<SubmissionSuccess, ReviewSubmissionFailure>> {
  if (input.draft.state._tag !== "LocalDraft") return err({ _tag: "DraftNotCreatable" });
  const comments = postableComments(input.draft);
  if (comments.length === 0) return err({ _tag: "NoPostableComments" });

  const currentHead = await verifiedCurrentHead(input.profile, input.session, input.gateway);
  if (currentHead._tag === "err") return currentHead;
  const stale = staleHead(input.session, input.draft, currentHead.value, input.now);
  if (stale !== undefined) return err(stale);

  // No await occurs between the verified head comparison above and this explicit GitHub create call.
  const created = await input.gateway.createPendingReview({
    profile: input.profile,
    pr: sessionPr(input.session),
    headSha: input.session.key.headSha,
    summaryBody: input.draft.summaryBody,
    comments,
  });
  if (created._tag === "err") {
    const failed = failedDraft(input.draft, created.error.category, comments, input.now);
    const session = withDraft(input.session, failed, input.now);
    return err(
      created.error.category === "rejected"
        ? { _tag: "GitHubWriteRejected", session, draft: failed }
        : { _tag: "GitHubCreateAmbiguous", session, draft: failed },
    );
  }

  const draft: ReviewDraft = {
    ...input.draft,
    state: {
      _tag: "PendingGitHubReview",
      pendingReviewId: created.value.reviewId,
      commentCount: comments.length,
    },
    updatedAt: input.now,
  };
  return ok({ session: withDraft(input.session, draft, input.now), draft });
}

/** Submits only a known pending review, with its selected event and summary body and no second comment batch. */
export async function submitPendingReview(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly session: ReviewSession;
  readonly draft: ReviewDraft;
  readonly event: GitHubReviewEvent;
  readonly summaryBody: string;
  readonly gateway: ReviewGateway;
  readonly now: IsoTimestamp;
}): Promise<Result<SubmissionSuccess, ReviewSubmissionFailure>> {
  if (!isReviewEvent(input.event) || input.summaryBody.trim().length === 0)
    return err({ _tag: "InvalidSubmitReview" });
  if (input.session.submittedReview !== undefined) return err({ _tag: "ReviewAlreadySubmitted" });
  if (input.draft.state._tag !== "PendingGitHubReview") return err({ _tag: "PendingReviewRequired" });

  const currentHead = await verifiedCurrentHead(input.profile, input.session, input.gateway);
  if (currentHead._tag === "err") return currentHead;
  const stale = staleHead(input.session, input.draft, currentHead.value, input.now);
  if (stale !== undefined) return err(stale);

  // No await occurs between the verified head comparison above and this explicit submit call.
  const submitted = await input.gateway.submitPendingReview({
    profile: input.profile,
    pr: sessionPr(input.session),
    reviewId: input.draft.state.pendingReviewId,
    event: input.event,
    summaryBody: input.summaryBody.trim(),
  });
  if (submitted._tag === "err")
    return err({ _tag: "GitHubSubmitFailed", session: input.session, draft: input.draft });

  const draft: ReviewDraft = {
    ...input.draft,
    state: {
      _tag: "SubmittedGitHubReview",
      reviewId: submitted.value.reviewId,
      event: input.event,
    },
    summaryBody: input.summaryBody.trim(),
    suggestedEvent: input.event,
    updatedAt: input.now,
  };
  return ok({
    draft,
    session: {
      ...withDraft(input.session, draft, input.now),
      submittedReview: {
        reviewId: submitted.value.reviewId,
        event: input.event,
        submittedAt: input.now,
      },
    },
  });
}

/** Explicit summary-only action: submits a known pending review as COMMENT without adding or splitting inline comments. */
export async function submitSummaryOnlyPendingReview(input: Omit<
  Parameters<typeof submitPendingReview>[0],
  "event"
>): Promise<Result<SubmissionSuccess, ReviewSubmissionFailure>> {
  return submitPendingReview({ ...input, event: "COMMENT" });
}

function postableComments(draft: ReviewDraft): ReadonlyArray<PendingReviewComment> {
  return draft.comments.flatMap((comment) =>
    comment.include && comment.postability === "postable" && comment.body.trim().length > 0
      ? [{ body: comment.body, path: comment.path, line: comment.line, ...(comment.lineEnd === undefined ? {} : { lineEnd: comment.lineEnd }), diffSide: comment.diffSide }]
      : [],
  );
}

async function verifiedCurrentHead(
  profile: WorkspaceProfileConfig,
  session: ReviewSession,
  gateway: ReviewGateway,
): Promise<Result<GitSha, ReviewSubmissionFailure>> {
  const current = await gateway.getPullRequest({ profile, pr: sessionPr(session) });
  return current._tag === "err"
    ? err({ _tag: "GitHubHeadReadFailed" })
    : ok(current.value.headSha);
}

function staleHead(
  session: ReviewSession,
  draft: ReviewDraft,
  currentHeadSha: GitSha,
  now: IsoTimestamp,
): Extract<ReviewSubmissionFailure, { readonly _tag: "StaleHeadBlocksWrite" }> | undefined {
  if (session.key.headSha === currentHeadSha && session.state._tag !== "Stale") return undefined;
  return {
    _tag: "StaleHeadBlocksWrite",
    draft,
    session: {
      ...session,
      state: { _tag: "Stale", reason: "head_changed", currentHeadSha },
      updatedAt: now,
    },
  };
}

function failedDraft(
  draft: ReviewDraft,
  category: "auth" | "rejected" | "unavailable",
  sent: ReadonlyArray<PendingReviewComment>,
  updatedAt: IsoTimestamp,
): ReviewDraft {
  const sentKeys = new Set(sent.map((comment) => `${comment.path}:${comment.line}:${comment.body}`));
  return {
    ...draft,
    state: {
      _tag: "DraftFailed",
      error: {
        _tag: "GitHubWriteFailure",
        category,
        message: category === "rejected" ? "GitHub rejected the pending-review batch; the draft was retained." : "GitHub could not confirm the pending-review create; retry is blocked to avoid a duplicate review.",
      },
    },
    comments: draft.comments.map((comment) =>
      sentKeys.has(`${comment.path}:${comment.line}:${comment.body}`)
        ? { ...comment, postability: "api_rejected" as const }
        : comment,
    ),
    updatedAt,
  };
}

function isReviewEvent(value: unknown): value is GitHubReviewEvent {
  return value === "APPROVE" || value === "COMMENT" || value === "REQUEST_CHANGES";
}

function withDraft(session: ReviewSession, draft: ReviewDraft, updatedAt: IsoTimestamp): ReviewSession {
  return { ...session, draft: { state: draft.state }, draftContent: draft, updatedAt };
}

function sessionPr(session: ReviewSession): PullRequestRef {
  return { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber };
}

/** Plans the persisted, confirmed remote operations in their only legal order. */
export function planBatchOperations(batch: ReviewBatch): ReadonlyArray<BatchOperation> {
  const inline = batch.items.filter((item): item is Extract<ReviewBatchItem, { readonly _tag: "InlineComment" }> => item._tag === "InlineComment" && item.include && item.postability === "postable");
  const thread = batch.items.filter((item) => item.include && (item._tag === "ThreadReply" || item._tag === "ThreadState"));
  return [
    ...(inline.length === 0 ? [] : [{ _tag: "CreatePendingReview" as const, itemIds: inline.map((item) => item.id) }]),
    ...thread.map((item) => item._tag === "ThreadReply" ? ({ _tag: "Reply" as const, itemId: item.id }) : ({ _tag: "ThreadState" as const, itemId: item.id })),
  ];
}

export type BatchApplyFailure = { readonly _tag: "StaleHeadBlocksWrite" | "BatchOutcomeUnknown" | "BatchWriteRejected" | "BatchWriterUnavailable"; readonly session: ReviewSession; readonly batch: ReviewBatch };

/** Applies one confirmed batch, durably recording the state before every remote operation. */
export async function applyReviewBatch(input: {
  readonly profile: WorkspaceProfileConfig; readonly session: ReviewSession; readonly batch: ReviewBatch; readonly gateway: ReviewGateway;
  readonly now: IsoTimestamp; readonly persist: (session: ReviewSession) => Promise<boolean>;
}): Promise<Result<{ readonly session: ReviewSession; readonly batch: ReviewBatch }, BatchApplyFailure>> {
  const current = await verifiedCurrentHead(input.profile, input.session, input.gateway);
  if (current._tag === "err" || current.value !== input.session.key.headSha) {
    const stale = { ...input.session, state: { _tag: "Stale" as const, reason: "head_changed" as const, ...(current._tag === "ok" ? { currentHeadSha: current.value } : {}) }, updatedAt: input.now };
    return err({ _tag: "StaleHeadBlocksWrite", session: stale, batch: input.batch });
  }
  let batch = input.batch;
  let session = input.session;
  for (const operation of planBatchOperations(batch)) {
    batch = { ...batch, state: { _tag: "Applying", operation }, updatedAt: input.now };
    session = { ...session, batch: { state: batch.state }, batchContent: batch, updatedAt: input.now };
    if (!(await input.persist(session))) return err({ _tag: "BatchOutcomeUnknown", session, batch });
    const item = operation._tag === "CreatePendingReview" ? undefined : batch.items.find((value) => value.id === operation.itemId);
    let receipt: ReviewBatch["receipts"][number] | undefined;
    if (operation._tag === "CreatePendingReview") {
      const comments = batch.items.filter((value): value is Extract<ReviewBatchItem, { readonly _tag: "InlineComment" }> => value._tag === "InlineComment" && operation.itemIds.includes(value.id)).map((value) => ({ body: value.body, path: value.anchor.path, line: value.anchor.line, ...(value.anchor.startLine === value.anchor.line ? {} : { lineEnd: value.anchor.startLine }), diffSide: value.anchor.side }));
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
  batch = { ...batch, state: pending === undefined ? { _tag: "Completed" } : { _tag: "PendingReview", reviewId: pending.reviewId }, updatedAt: input.now };
  session = { ...session, batch: { state: batch.state }, batchContent: batch, updatedAt: input.now };
  return (await input.persist(session)) ? ok({ session, batch }) : err({ _tag: "BatchOutcomeUnknown", session, batch });
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
