import * as v from "valibot";

import { definedProps } from "./defined-props";
import {
  parseGitHubHost,
  parseGitHubLogin,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubReviewCommentId,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitSha,
  parseContentHash,
  parseFindingId,
  parseInsightRunId,
  parseIsoTimestamp,
  parsePendingReviewRequestId,
  parsePullRequestNumber,
  parseRepoRelativePath,
  parseReviewSessionId,
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
  type ContentHash,
  type FindingId,
  type InsightRunId,
  type ReviewSessionId,
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
/** Immutable Analysis identity carried with the one pending-review write it authorizes. */
export type FindingReviewSource = {
  readonly analysisRunId: InsightRunId;
  readonly findingId: FindingId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
};

/** Durable proof that one Analysis Finding owns an exact GitHub review thread. */
export type FindingReviewReceipt = FindingReviewSource & {
  readonly threadId: GitHubThreadId;
  readonly pendingReviewNodeId: GitHubReviewNodeId;
  readonly state: "pending" | "published" | "historical";
};

/** The adapter must return the identity it created; the service never guesses it. */
export type PendingReviewThreadWrite = {
  readonly review: ViewerPendingReview;
  readonly createdThreadId: GitHubThreadId;
};

/** One durable remote write planned against the pending-review owner. */
export type PendingReviewOperation =
  | {
      readonly _tag: "Start";
      readonly requestId: PendingReviewRequestId;
      readonly finding?: FindingReviewSource;
    }
  | {
      readonly _tag: "AddThread";
      readonly requestId: PendingReviewRequestId;
      readonly reviewId: GitHubReviewNodeId;
      readonly anchor: PendingReviewAnchor;
      readonly finding?: FindingReviewSource;
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
  | {
      readonly _tag: "Pending";
      readonly review: ViewerPendingReview;
      readonly unresolvedFinding?: FindingReviewSource;
    }
  | {
      readonly _tag: "WriteInFlight";
      readonly review?: ViewerPendingReview;
      readonly unresolvedFinding?: FindingReviewSource;
      readonly operation: PendingReviewOperation;
      readonly startedAt: IsoTimestamp;
    }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly review?: ViewerPendingReview;
      readonly unresolvedFinding?: FindingReviewSource;
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

/** Whether a pending-review state carries an uncertain write lock. */
export function isPendingReviewLocked(state: PendingReviewState): boolean {
  return state._tag === "WriteInFlight" || state._tag === "OutcomeUnknown";
}
/**
 * Adopt the authenticated viewer's authoritative remote draft only when no
 * write is in flight or uncertain. A locked operation owns its recovery
 * evidence; an ordinary observation must not replace it.
 */
export function adoptObservedPendingReview(
  current: PendingReviewState,
  observed: PendingReviewRead,
): PendingReviewState {
  if (isPendingReviewLocked(current) || observed._tag === "Unavailable")
    return current;
  if (observed._tag !== "Pending") return { _tag: "None" };
  return pendingOwner(
    observed.review,
    current._tag === "Pending" &&
      current.review.nodeId === observed.review.nodeId
      ? current.unresolvedFinding
      : undefined,
  );
}

/** Whether an operation can start from the current state. */
export function canStartPendingReviewOperation(
  state: PendingReviewState,
  operation: PendingReviewOperation,
): boolean {
  if (isPendingReviewLocked(state)) return false;
  if (operation._tag === "Start") return state._tag === "None";
  if (operation._tag === "AddThread") {
    return (
      state._tag === "Pending" && state.review.nodeId === operation.reviewId
    );
  }
  if (operation._tag === "Submit" || operation._tag === "Discard") {
    return (
      state._tag === "Pending" && state.review.restId === operation.reviewId
    );
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
    ...definedProps({
      review: state._tag === "Pending" ? state.review : undefined,
      unresolvedFinding:
        state._tag === "Pending" && state.unresolvedFinding !== undefined
          ? state.unresolvedFinding
          : undefined,
    }),
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
    : ok({
        _tag: "Pending",
        review: nextReview,
        ...definedProps({ unresolvedFinding: state.unresolvedFinding }),
      });
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
    : ok({
        _tag: "Pending",
        review: state.review,
        ...definedProps({ unresolvedFinding: state.unresolvedFinding }),
      });
}

/** A timeout, lost response, or failed receipt persistence becomes OutcomeUnknown. */
export function markPendingReviewOutcomeUnknown(
  state: PendingReviewState,
): Result<PendingReviewState, InvalidPendingReview> {
  if (state._tag !== "WriteInFlight") return invalidPendingReview();
  return ok({
    _tag: "OutcomeUnknown",
    ...definedProps({
      review: state.review,
      unresolvedFinding: state.unresolvedFinding,
    }),
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
  if (
    (operation._tag === "Start" || operation._tag === "AddThread") &&
    operation.finding !== undefined
  ) {
    // The remote owner alone cannot prove which exact thread this Finding
    // created. Keep that one Finding locked, but expose the proven owner for
    // inspection, other comments, submission, or discard.
    if (read._tag === "Pending") {
      return {
        _tag: "Pending",
        review: read.review,
        unresolvedFinding: operation.finding,
      };
    }
    return operation._tag === "Start" ? { _tag: "None" } : state;
  }
  if (operation._tag === "Start") {
    return read._tag === "Pending"
      ? { _tag: "Pending", review: read.review }
      : { _tag: "None" };
  }
  if (operation._tag === "Submit") {
    if (read._tag === "Pending") {
      // The pending review still exists: the submit did not execute. The lock
      // lifts to the confirmed Pending owner so the maintainer can retry.
      return pendingOwner(read.review, state.unresolvedFinding);
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
      return pendingOwner(read.review, state.unresolvedFinding);
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
    return landed ? pendingOwner(read.review, state.unresolvedFinding) : state;
  }
  // The review is gone (submitted or absent): without thread identity proof
  // the outcome stays locked.
  return state;
}

function pendingOwner(
  review: ViewerPendingReview,
  unresolvedFinding: FindingReviewSource | undefined,
): PendingReviewState {
  return {
    _tag: "Pending",
    review,
    ...definedProps({ unresolvedFinding }),
  };
}

export type InvalidPendingReviewState = {
  readonly _tag: "InvalidPendingReviewState";
};

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

const findingSourceSchema = v.strictObject({
  analysisRunId: v.string(),
  findingId: v.string(),
  sessionId: v.string(),
  headSha: v.string(),
  patchHash: v.string(),
});

const findingReceiptSchema = v.strictObject({
  analysisRunId: v.string(),
  findingId: v.string(),
  sessionId: v.string(),
  headSha: v.string(),
  patchHash: v.string(),
  threadId: v.string(),
  pendingReviewNodeId: v.string(),
  state: v.picklist(["pending", "published", "historical"]),
});

const operationSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("Start"),
    requestId: v.string(),
    finding: v.optional(findingSourceSchema),
  }),
  v.strictObject({
    _tag: v.literal("AddThread"),
    requestId: v.string(),
    reviewId: v.string(),
    anchor: anchorSchema,
    finding: v.optional(findingSourceSchema),
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
    unresolvedFinding: v.optional(findingSourceSchema),
  }),
  v.strictObject({
    _tag: v.literal("WriteInFlight"),
    review: v.optional(reviewSchema),
    unresolvedFinding: v.optional(findingSourceSchema),
    operation: operationSchema,
    startedAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("OutcomeUnknown"),
    review: v.optional(reviewSchema),
    unresolvedFinding: v.optional(findingSourceSchema),
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
  const review =
    reviewInput === undefined
      ? ok(undefined)
      : parseViewerPendingReview(reviewInput);
  if (review._tag === "err") return invalidPendingReviewState();
  const operation =
    raw.output._tag === "WriteInFlight" || raw.output._tag === "OutcomeUnknown"
      ? parseOperation(raw.output.operation)
      : ok(undefined);
  if (operation._tag === "err") return invalidPendingReviewState();
  if (raw.output._tag === "None") return ok({ _tag: "None" });
  if (raw.output._tag === "Pending") {
    if (review.value === undefined) return invalidPendingReviewState();
    const unresolvedFinding =
      raw.output.unresolvedFinding === undefined
        ? ok(undefined)
        : parseFindingReviewSource(raw.output.unresolvedFinding);
    return unresolvedFinding._tag === "err"
      ? unresolvedFinding
      : ok({
          _tag: "Pending",
          review: review.value,
          ...definedProps({ unresolvedFinding: unresolvedFinding.value }),
        });
  }
  if (operation.value === undefined || startedAt.value === undefined) {
    return invalidPendingReviewState();
  }
  const unresolvedFinding =
    raw.output.unresolvedFinding === undefined
      ? ok(undefined)
      : parseFindingReviewSource(raw.output.unresolvedFinding);
  if (unresolvedFinding._tag === "err") return unresolvedFinding;
  return ok({
    _tag: raw.output._tag,
    ...definedProps({
      review: review.value,
      unresolvedFinding: unresolvedFinding.value,
    }),
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
    pr: {
      host: host.value,
      owner: owner.value,
      repo: repo.value,
      number: number.value,
    },
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

function parseFindingReviewSource(
  input: unknown,
): Result<FindingReviewSource, InvalidPendingReviewState> {
  const raw = v.safeParse(findingSourceSchema, input);
  if (!raw.success) return invalidPendingReviewState();
  const analysisRunId = parseInsightRunId(raw.output.analysisRunId);
  const findingId = parseFindingId(raw.output.findingId);
  const sessionId = parseReviewSessionId(raw.output.sessionId);
  const headSha = parseGitSha(raw.output.headSha);
  const patchHash = parseContentHash(raw.output.patchHash);
  if (
    analysisRunId._tag === "err" ||
    findingId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
  )
    return invalidPendingReviewState();
  return ok({
    analysisRunId: analysisRunId.value,
    findingId: findingId.value,
    sessionId: sessionId.value,
    headSha: headSha.value,
    patchHash: patchHash.value,
  });
}

function parseOperation(
  input: v.InferOutput<typeof operationSchema>,
): Result<PendingReviewOperation, InvalidPendingReviewState> {
  const requestId = parsePendingReviewRequestId(input.requestId);
  if (requestId._tag === "err") return invalidPendingReviewState();
  if (input._tag === "Start") {
    const finding =
      input.finding === undefined
        ? ok(undefined)
        : parseFindingReviewSource(input.finding);
    return finding._tag === "err"
      ? finding
      : ok({
          _tag: "Start",
          requestId: requestId.value,
          ...definedProps({ finding: finding.value }),
        });
  }
  if (input._tag === "Submit" || input._tag === "Discard") {
    const reviewId = parseGitHubReviewRestId(input.reviewId);
    return reviewId._tag === "err"
      ? invalidPendingReviewState()
      : input._tag === "Submit"
        ? ok({
            _tag: "Submit",
            requestId: requestId.value,
            reviewId: reviewId.value,
            event: input.event,
          })
        : ok({
            _tag: "Discard",
            requestId: requestId.value,
            reviewId: reviewId.value,
          });
  }
  const reviewId = parseGitHubReviewNodeId(input.reviewId);
  const anchor = parseAnchor(input.anchor);
  const finding =
    input.finding === undefined
      ? ok(undefined)
      : parseFindingReviewSource(input.finding);
  return reviewId._tag === "err" ||
    anchor === undefined ||
    finding._tag === "err"
    ? invalidPendingReviewState()
    : ok({
        _tag: "AddThread",
        requestId: requestId.value,
        reviewId: reviewId.value,
        anchor,
        ...definedProps({ finding: finding.value }),
      });
}

function invalidPendingReview(): Result<never, InvalidPendingReview> {
  return err({ _tag: "InvalidPendingReview" });
}

function invalidPendingReviewState(): Result<never, InvalidPendingReviewState> {
  return err({ _tag: "InvalidPendingReviewState" });
}

/** Parse receipts and reject duplicate Finding identities or unproven pending threads. */
export function parseFindingReviewReceipts(
  input: unknown,
  session: {
    readonly id: ReviewSessionId;
    readonly headSha: GitSha;
    readonly pendingReview?: PendingReviewState;
  },
): Result<ReadonlyArray<FindingReviewReceipt>, InvalidPendingReviewState> {
  const raw = v.safeParse(v.array(findingReceiptSchema), input);
  if (!raw.success) return invalidPendingReviewState();
  const receipts: FindingReviewReceipt[] = [];
  const identities = new Set<string>();
  for (const value of raw.output) {
    const source = parseFindingReviewSource({
      analysisRunId: value.analysisRunId,
      findingId: value.findingId,
      sessionId: value.sessionId,
      headSha: value.headSha,
      patchHash: value.patchHash,
    });
    const threadId = parseGitHubThreadId(value.threadId);
    const pendingReviewNodeId = parseGitHubReviewNodeId(
      value.pendingReviewNodeId,
    );
    if (
      source._tag === "err" ||
      threadId._tag === "err" ||
      pendingReviewNodeId._tag === "err" ||
      source.value.sessionId !== session.id ||
      source.value.headSha !== session.headSha
    )
      return invalidPendingReviewState();
    const identity = `${source.value.analysisRunId}:${source.value.findingId}:${source.value.sessionId}:${source.value.headSha}:${source.value.patchHash}`;
    if (identities.has(identity)) return invalidPendingReviewState();
    identities.add(identity);
    const owner = pendingReviewOwner(session.pendingReview);
    if (
      value.state === "pending" &&
      (owner === undefined ||
        owner.nodeId !== pendingReviewNodeId.value ||
        !owner.comments.some((comment) => comment.threadId === threadId.value))
    )
      return invalidPendingReviewState();
    receipts.push({
      ...source.value,
      threadId: threadId.value,
      pendingReviewNodeId: pendingReviewNodeId.value,
      state: value.state,
    });
  }
  return ok(receipts);
}

function pendingReviewOwner(
  state: PendingReviewState | undefined,
): ViewerPendingReview | undefined {
  if (state?._tag === "Pending") return state.review;
  if (state?._tag === "WriteInFlight" || state?._tag === "OutcomeUnknown") {
    return state.review;
  }
  return undefined;
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
