import * as v from "valibot";

import {
  parseGitHubHost,
  parseGitHubLogin,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubReviewCommentId,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitSha,
  parseIsoTimestamp,
  parsePendingReviewRequestId,
  parsePullRequestNumber,
  parseRepoRelativePath,
  parseGitHubThreadId,
  type GitHubLogin,
  type GitHubReviewNodeId,
  type GitHubReviewRestId,
  type GitSha,
  type IsoTimestamp,
  type PendingReviewRequestId,
  type RepoRelativePath,
  type GitHubThreadId,
  type GitHubReviewCommentId,
} from "./ids";
import type { PullRequestRef } from "./pull-request";
import { err, ok, type Result } from "./result";

/** The GitHub review verdict submitted with a pending review. */
export type GitHubReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

/** A side-aware line or range in one repository-relative file. */
export type PendingReviewAnchor = {
  readonly path: RepoRelativePath;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
};

/** One actionable pending review comment with its thread and anchor. */
export type PendingReviewComment = {
  readonly reviewCommentId: GitHubReviewCommentId;
  readonly threadId: GitHubThreadId;
  readonly body: string;
  readonly anchor: PendingReviewAnchor;
  readonly createdAt: IsoTimestamp;
};

/** The authenticated viewer's one remote pending review for a pull request. */
export type ViewerPendingReview = {
  readonly restId: GitHubReviewRestId;
  readonly nodeId: GitHubReviewNodeId;
  readonly author: GitHubLogin;
  readonly pr: PullRequestRef;
  readonly headSha: GitSha;
  readonly comments: ReadonlyArray<PendingReviewComment>;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

/** One durable remote write planned against the pending-review owner. */
export type PendingReviewOperation =
  | { readonly _tag: "Start"; readonly requestId: PendingReviewRequestId }
  | {
      readonly _tag: "AddThread";
      readonly requestId: PendingReviewRequestId;
      readonly reviewId: GitHubReviewNodeId;
      readonly anchor: PendingReviewAnchor;
    }
  | {
      readonly _tag: "Submit";
      readonly requestId: PendingReviewRequestId;
      readonly reviewId: GitHubReviewRestId;
      readonly event: GitHubReviewEvent;
    }
  | {
      readonly _tag: "Discard";
      readonly requestId: PendingReviewRequestId;
      readonly reviewId: GitHubReviewRestId;
    };

/**
 * The durable pending-review lifecycle. WriteInFlight and OutcomeUnknown are
 * durable recovery evidence, not button state: they lock conflicting writes
 * until a read-side reconciliation maps the remote result.
 */
export type PendingReviewState =
  | { readonly _tag: "None" }
  | { readonly _tag: "Pending"; readonly review: ViewerPendingReview }
  | {
      readonly _tag: "WriteInFlight";
      readonly review?: ViewerPendingReview;
      readonly operation: PendingReviewOperation;
      readonly startedAt: IsoTimestamp;
    }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly review?: ViewerPendingReview;
      readonly operation: PendingReviewOperation;
      readonly startedAt: IsoTimestamp;
    };

/** A bounded pending-review read result. Unavailable is never None. */
export type PendingReviewRead =
  | { readonly _tag: "None" }
  | { readonly _tag: "Pending"; readonly review: ViewerPendingReview }
  | { readonly _tag: "Unavailable" };

/** Typed failure for a pending-review write or reconciliation. */
export type PendingReviewWriteFailure =
  | { readonly _tag: "NotFresh" }
  | { readonly _tag: "HeadChanged"; readonly currentHeadSha: GitSha }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "PermissionDenied" }
  | { readonly _tag: "Rejected" }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "OutcomeUnknown" };

export type InvalidPendingReview = {
  readonly _tag: "InvalidPendingReview";
};

/** Whether a pending-review state is a confirmed actionable owner. */
export function isPendingReviewConfirmed(
  state: PendingReviewState,
): state is { readonly _tag: "Pending"; readonly review: ViewerPendingReview } {
  return state._tag === "Pending";
}

/** Whether a pending-review state carries an uncertain write lock. */
export function isPendingReviewLocked(state: PendingReviewState): boolean {
  return state._tag === "WriteInFlight" || state._tag === "OutcomeUnknown";
}

/** Whether an operation can start from the current state. */
export function canStartPendingReviewOperation(
  state: PendingReviewState,
  operation: PendingReviewOperation,
): boolean {
  if (isPendingReviewLocked(state)) return false;
  if (operation._tag === "Start") return state._tag === "None";
  if (operation._tag === "AddThread") {
    return state._tag === "Pending" && state.review.nodeId === operation.reviewId;
  }
  if (operation._tag === "Submit" || operation._tag === "Discard") {
    return state._tag === "Pending" && state.review.restId === operation.reviewId;
  }
  return false;
}

/** Enter WriteInFlight after persisting the operation intent. */
export function beginPendingReviewWrite(
  state: PendingReviewState,
  operation: PendingReviewOperation,
  startedAt: IsoTimestamp,
): Result<PendingReviewState, InvalidPendingReview> {
  if (!canStartPendingReviewOperation(state, operation)) {
    return invalidPendingReview();
  }
  return ok({
    _tag: "WriteInFlight",
    ...(state._tag === "Pending" ? { review: state.review } : {}),
    operation,
    startedAt,
  });
}

/** A confirmed write receipt replaces the durable state. */
export function confirmPendingReviewWrite(
  state: PendingReviewState,
  nextReview: ViewerPendingReview | undefined,
): Result<PendingReviewState, InvalidPendingReview> {
  if (state._tag !== "WriteInFlight") return invalidPendingReview();
  return nextReview === undefined
    ? ok({ _tag: "None" })
    : ok({ _tag: "Pending", review: nextReview });
}

/**
 * A rejected or permission failure leaves the last confirmed remote state
 * unchanged; the caller surfaces bounded copy without a recovery lock.
 */
export function rejectPendingReviewWrite(
  state: PendingReviewState,
): Result<PendingReviewState, InvalidPendingReview> {
  if (state._tag !== "WriteInFlight") return invalidPendingReview();
  return state.review === undefined
    ? ok({ _tag: "None" })
    : ok({ _tag: "Pending", review: state.review });
}

/** A timeout, lost response, or failed receipt persistence becomes OutcomeUnknown. */
export function markPendingReviewOutcomeUnknown(
  state: PendingReviewState,
): Result<PendingReviewState, InvalidPendingReview> {
  if (state._tag !== "WriteInFlight") return invalidPendingReview();
  return ok({
    _tag: "OutcomeUnknown",
    ...(state.review === undefined ? {} : { review: state.review }),
    operation: state.operation,
    startedAt: state.startedAt,
  });
}

/**
 * Map a bounded read result onto a locked WriteInFlight/OutcomeUnknown state.
 * Only a proven remote result resolves the lock; everything else stays locked.
 */
export function reconcilePendingReviewState(
  state: PendingReviewState,
  read: PendingReviewRead,
): PendingReviewState {
  if (state._tag !== "WriteInFlight" && state._tag !== "OutcomeUnknown") {
    return state;
  }
  if (read._tag === "Unavailable") return state;
  const operation = state.operation;
  const startedAt = state.startedAt;
  if (operation._tag === "Start") {
    return read._tag === "Pending" ? { _tag: "Pending", review: read.review } : { _tag: "None" };
  }
  if (operation._tag === "Submit") {
    if (read._tag === "Pending") {
      // The pending review still exists: the submit did not execute. The lock
      // lifts to the confirmed Pending owner so the maintainer can retry.
      return { _tag: "Pending", review: read.review };
    }
    if (read._tag === "None") {
      // No pending review remains. Without a matching submitted-review
      // receipt this may still be ambiguous, so the lock stays.
      return state;
    }
    return state;
  }
  if (operation._tag === "Discard") {
    if (read._tag === "Pending") {
      // The pending review still exists: the discard did not execute. The
      // lock lifts to the confirmed Pending owner so the maintainer can
      // retry.
      return { _tag: "Pending", review: read.review };
    }
    if (read._tag === "None") {
      // No viewer pending review remains: the discard intent is satisfied
      // (or an equivalent absence was reached). Unlike Submit there is no
      // submitted-artifact ambiguity to protect, so the lock resolves to
      // None and a fresh review may be started.
      return { _tag: "None" };
    }
    return state;
  }
  // AddThread
  if (read._tag === "Pending") {
    // The thread created by this operation is a thread on the same review
    // with a comment newer than the write start.
    const landed = read.review.comments.some(
      (comment) => comment.createdAt > startedAt,
    );
    return landed ? { _tag: "Pending", review: read.review } : state;
  }
  // The review is gone (submitted or absent): without thread identity proof
  // the outcome stays locked.
  return state;
}

export type InvalidPendingReviewState = { readonly _tag: "InvalidPendingReviewState" };

const anchorSchema = v.strictObject({
  path: v.string(),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  side: v.picklist(["new", "old"]),
});

const commentSchema = v.strictObject({
  reviewCommentId: v.string(),
  threadId: v.string(),
  body: v.string(),
  anchor: anchorSchema,
  createdAt: v.string(),
});

const reviewSchema = v.strictObject({
  restId: v.string(),
  nodeId: v.string(),
  author: v.string(),
  pr: v.strictObject({
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    number: v.number(),
  }),
  headSha: v.string(),
  comments: v.array(commentSchema),
  createdAt: v.string(),
  updatedAt: v.string(),
});

const operationSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("Start"),
    requestId: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("AddThread"),
    requestId: v.string(),
    reviewId: v.string(),
    anchor: anchorSchema,
  }),
  v.strictObject({
    _tag: v.literal("Submit"),
    requestId: v.string(),
    reviewId: v.string(),
    event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  }),
  v.strictObject({
    _tag: v.literal("Discard"),
    requestId: v.string(),
    reviewId: v.string(),
  }),
]);

const stateSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("None") }),
  v.strictObject({
    _tag: v.literal("Pending"),
    review: reviewSchema,
  }),
  v.strictObject({
    _tag: v.literal("WriteInFlight"),
    review: v.optional(reviewSchema),
    operation: operationSchema,
    startedAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("OutcomeUnknown"),
    review: v.optional(reviewSchema),
    operation: operationSchema,
    startedAt: v.string(),
  }),
]);

/** Parse persisted pending-review state into typed domain values. */
export function parsePendingReviewState(
  input: unknown,
): Result<PendingReviewState, InvalidPendingReviewState> {
  const raw = v.safeParse(stateSchema, input);
  if (!raw.success) return invalidPendingReviewState();
  const startedAt =
    raw.output._tag === "WriteInFlight" || raw.output._tag === "OutcomeUnknown"
      ? parseIsoTimestamp(raw.output.startedAt)
      : ok(undefined);
  if (startedAt._tag === "err") return invalidPendingReviewState();
  const reviewInput =
    raw.output._tag === "Pending" ||
    raw.output._tag === "WriteInFlight" ||
    raw.output._tag === "OutcomeUnknown"
      ? raw.output.review
      : undefined;
  const review = reviewInput === undefined ? ok(undefined) : parseViewerPendingReview(reviewInput);
  if (review._tag === "err") return invalidPendingReviewState();
  const operation =
    raw.output._tag === "WriteInFlight" || raw.output._tag === "OutcomeUnknown"
      ? parseOperation(raw.output.operation)
      : ok(undefined);
  if (operation._tag === "err") return invalidPendingReviewState();
  if (raw.output._tag === "None") return ok({ _tag: "None" });
  if (raw.output._tag === "Pending") {
    return review.value === undefined
      ? invalidPendingReviewState()
      : ok({ _tag: "Pending", review: review.value });
  }
  if (operation.value === undefined || startedAt.value === undefined) {
    return invalidPendingReviewState();
  }
  return ok({
    _tag: raw.output._tag,
    ...(review.value === undefined ? {} : { review: review.value }),
    operation: operation.value,
    startedAt: startedAt.value,
  });
}

/** Parse a viewer pending review from a validated wire or stored shape. */
export function parseViewerPendingReview(
  input: unknown,
): Result<ViewerPendingReview, InvalidPendingReviewState> {
  const raw = v.safeParse(reviewSchema, input);
  if (!raw.success) return invalidPendingReviewState();
  const restId = parseGitHubReviewRestId(raw.output.restId);
  const nodeId = parseGitHubReviewNodeId(raw.output.nodeId);
  const author = parseGitHubLogin(raw.output.author);
  const host = parseGitHubHost(raw.output.pr.host);
  const owner = parseGitHubOwner(raw.output.pr.owner);
  const repo = parseGitHubRepoName(raw.output.pr.repo);
  const number = parsePullRequestNumber(raw.output.pr.number);
  const headSha = parseGitSha(raw.output.headSha);
  const createdAt = parseIsoTimestamp(raw.output.createdAt);
  const updatedAt = parseIsoTimestamp(raw.output.updatedAt);
  if (
    restId._tag === "err" ||
    nodeId._tag === "err" ||
    author._tag === "err" ||
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err" ||
    headSha._tag === "err" ||
    createdAt._tag === "err" ||
    updatedAt._tag === "err"
  ) {
    return invalidPendingReviewState();
  }
  const comments: PendingReviewComment[] = [];
  const threadIds = new Set<GitHubThreadId>();
  for (const comment of raw.output.comments) {
    const parsed = parseComment(comment);
    if (parsed._tag === "err" || threadIds.has(parsed.value.threadId)) {
      return invalidPendingReviewState();
    }
    threadIds.add(parsed.value.threadId);
    comments.push(parsed.value);
  }
  return ok({
    restId: restId.value,
    nodeId: nodeId.value,
    author: author.value,
    pr: { host: host.value, owner: owner.value, repo: repo.value, number: number.value },
    headSha: headSha.value,
    comments,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function parseComment(
  input: v.InferOutput<typeof commentSchema>,
): Result<PendingReviewComment, InvalidPendingReviewState> {
  const reviewCommentId = parseGitHubReviewCommentId(input.reviewCommentId);
  const threadId = parseGitHubThreadId(input.threadId);
  const createdAt = parseIsoTimestamp(input.createdAt);
  const anchor = parseAnchor(input.anchor);
  if (
    reviewCommentId._tag === "err" ||
    threadId._tag === "err" ||
    createdAt._tag === "err" ||
    anchor === undefined
  ) {
    return invalidPendingReviewState();
  }
  return ok({
    reviewCommentId: reviewCommentId.value,
    threadId: threadId.value,
    body: input.body,
    anchor,
    createdAt: createdAt.value,
  });
}

function parseAnchor(
  input: v.InferOutput<typeof anchorSchema>,
): PendingReviewAnchor | undefined {
  const path = parseRepoRelativePath(input.path);
  if (path._tag === "err" || input.line < input.startLine) return undefined;
  return {
    path: path.value,
    startLine: input.startLine,
    line: input.line,
    side: input.side,
  };
}

function parseOperation(
  input: v.InferOutput<typeof operationSchema>,
): Result<PendingReviewOperation, InvalidPendingReviewState> {
  const requestId = parsePendingReviewRequestId(input.requestId);
  if (requestId._tag === "err") return invalidPendingReviewState();
  if (input._tag === "Start") return ok({ _tag: "Start", requestId: requestId.value });
  if (input._tag === "Submit" || input._tag === "Discard") {
    const reviewId = parseGitHubReviewRestId(input.reviewId);
    return reviewId._tag === "err"
      ? invalidPendingReviewState()
      : input._tag === "Submit"
        ? ok({ _tag: "Submit", requestId: requestId.value, reviewId: reviewId.value, event: input.event })
        : ok({ _tag: "Discard", requestId: requestId.value, reviewId: reviewId.value });
  }
  const reviewId = parseGitHubReviewNodeId(input.reviewId);
  const anchor = parseAnchor(input.anchor);
  return reviewId._tag === "err" || anchor === undefined
    ? invalidPendingReviewState()
    : ok({ _tag: "AddThread", requestId: requestId.value, reviewId: reviewId.value, anchor });
}

function invalidPendingReview(): Result<never, InvalidPendingReview> {
  return err({ _tag: "InvalidPendingReview" });
}

function invalidPendingReviewState(): Result<never, InvalidPendingReviewState> {
  return err({ _tag: "InvalidPendingReviewState" });
}

/** Session binding check: a confirmed review must belong to the session's pull request. */
export function pendingReviewMatchesSession(
  state: PendingReviewState,
  key: {
    readonly host: PullRequestRef["host"];
    readonly owner: PullRequestRef["owner"];
    readonly repo: PullRequestRef["repo"];
    readonly number: PullRequestRef["number"];
  },
): boolean {
  if (state._tag !== "Pending") return true;
  const review = state.review;
  return (
    review.pr.host === key.host &&
    review.pr.owner === key.owner &&
    review.pr.repo === key.repo &&
    review.pr.number === key.number
  );
}
