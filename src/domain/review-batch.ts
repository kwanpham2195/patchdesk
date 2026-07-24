import * as v from "valibot";

import {
  parseFindingId,
  parseGitHubThreadId,
  parseIsoTimestamp,
  parseLocalReviewItemId,
  parseRepoRelativePath,
  parseReviewAttemptId,
  parseReviewSessionId,
  type FindingId,
  type GitHubThreadId,
  type IsoTimestamp,
  type LocalReviewItemId,
  type RepoRelativePath,
  type ReviewAttemptId,
  type ReviewSessionId,
} from "./ids";
import { err, ok, type Result } from "./result";

/** The GitHub review verdict submitted after a pending review is ready. */
export type GitHubReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

/** Whether an inline comment can currently be sent to GitHub. */
export type Postability =
  | "postable"
  | "already_reported"
  | "invalid_line"
  | "stale_sha"
  | "api_rejected";

/** A side-aware line or range in one repository-relative file. */
export type ReviewAnchor = {
  readonly path: RepoRelativePath;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
};

/** One local action included in or excluded from a review batch. */
export type ReviewBatchItem =
  | {
      readonly _tag: "InlineComment";
      readonly id: LocalReviewItemId;
      readonly source: "finding" | "manual";
      readonly findingId?: FindingId;
      readonly anchor: ReviewAnchor;
      readonly body: string;
      readonly include: boolean;
      readonly postability: Postability;
    }
  | {
      readonly _tag: "ThreadReply";
      readonly id: LocalReviewItemId;
      readonly threadId: GitHubThreadId;
      readonly body: string;
      readonly include: boolean;
    }
  | {
      readonly _tag: "ThreadState";
      readonly id: LocalReviewItemId;
      readonly threadId: GitHubThreadId;
      readonly action: "resolve" | "reopen";
      readonly include: boolean;
    };

/** One durable GitHub write operation planned from a confirmed batch. */
export type BatchOperation =
  | {
      readonly _tag: "CreatePendingReview";
      readonly itemIds: ReadonlyArray<LocalReviewItemId>;
    }
  | {
      readonly _tag: "Reply";
      readonly itemId: LocalReviewItemId;
    }
  | {
      readonly _tag: "ThreadState";
      readonly itemId: LocalReviewItemId;
    };

/** A safe persisted summary of a known or ambiguous GitHub write failure. */
export type SafeWriteFailure = {
  readonly _tag: "SafeWriteFailure";
  readonly category: "auth" | "rejected" | "unavailable" | "outcome_unknown";
  readonly message: string;
};

/** The lifecycle of one durable review batch. */
export type ReviewBatchState =
  | { readonly _tag: "Local" }
  | { readonly _tag: "Applying"; readonly operation: BatchOperation }
  | {
      readonly _tag: "PartialFailure";
      readonly operation: BatchOperation;
      readonly failure: SafeWriteFailure;
    }
  | { readonly _tag: "PendingReview"; readonly reviewId: string }
  | {
      readonly _tag: "Submitted";
      readonly reviewId: string;
      readonly event: GitHubReviewEvent;
    };

/** A durable receipt proving one remote write completed successfully. */
export type RemoteWriteReceipt =
  | {
      readonly _tag: "PendingReviewCreated";
      readonly reviewId: string;
    }
  | {
      readonly _tag: "ReplyCreated";
      readonly itemId: LocalReviewItemId;
      readonly commentId: string;
    }
  | {
      readonly _tag: "ThreadStateChanged";
      readonly itemId: LocalReviewItemId;
      readonly state: "resolved" | "open";
    };

/** All local and completed remote review work for one session attempt. */
export type ReviewBatch = {
  readonly sessionId: ReviewSessionId;
  readonly attemptId: ReviewAttemptId;
  readonly state: ReviewBatchState;
  readonly summaryBody: string;
  readonly suggestedEvent: GitHubReviewEvent;
  readonly items: ReadonlyArray<ReviewBatchItem>;
  readonly receipts: ReadonlyArray<RemoteWriteReceipt>;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

/** A batch value failed strict boundary parsing. */
export type InvalidReviewBatch = {
  readonly _tag: "InvalidReviewBatch";
};

const localReviewItemIdSchema = v.string();
const githubThreadIdSchema = v.string();

const operationSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("CreatePendingReview"),
    itemIds: v.array(localReviewItemIdSchema),
  }),
  v.strictObject({
    _tag: v.literal("Reply"),
    itemId: localReviewItemIdSchema,
  }),
  v.strictObject({
    _tag: v.literal("ThreadState"),
    itemId: localReviewItemIdSchema,
  }),
]);

const safeWriteFailureSchema = v.strictObject({
  _tag: v.literal("SafeWriteFailure"),
  category: v.picklist([
    "auth",
    "rejected",
    "unavailable",
    "outcome_unknown",
  ]),
  message: v.pipe(v.string(), v.minLength(1)),
});

const stateSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("Local") }),
  v.strictObject({
    _tag: v.literal("Applying"),
    operation: operationSchema,
  }),
  v.strictObject({
    _tag: v.literal("PartialFailure"),
    operation: operationSchema,
    failure: safeWriteFailureSchema,
  }),
  v.strictObject({
    _tag: v.literal("PendingReview"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("Submitted"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
    event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  }),
]);

const itemSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("InlineComment"),
    id: localReviewItemIdSchema,
    source: v.picklist(["finding", "manual"]),
    findingId: v.optional(v.string()),
    anchor: v.strictObject({
      path: v.string(),
      startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
      line: v.pipe(v.number(), v.integer(), v.minValue(1)),
      side: v.picklist(["new", "old"]),
    }),
    body: v.string(),
    include: v.boolean(),
    postability: v.picklist([
      "postable",
      "already_reported",
      "invalid_line",
      "stale_sha",
      "api_rejected",
    ]),
  }),
  v.strictObject({
    _tag: v.literal("ThreadReply"),
    id: localReviewItemIdSchema,
    threadId: githubThreadIdSchema,
    body: v.string(),
    include: v.boolean(),
  }),
  v.strictObject({
    _tag: v.literal("ThreadState"),
    id: localReviewItemIdSchema,
    threadId: githubThreadIdSchema,
    action: v.picklist(["resolve", "reopen"]),
    include: v.boolean(),
  }),
]);

const receiptSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("PendingReviewCreated"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("ReplyCreated"),
    itemId: localReviewItemIdSchema,
    commentId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("ThreadStateChanged"),
    itemId: localReviewItemIdSchema,
    state: v.picklist(["resolved", "open"]),
  }),
]);

const batchSchema = v.strictObject({
  sessionId: v.string(),
  attemptId: v.string(),
  state: stateSchema,
  summaryBody: v.string(),
  suggestedEvent: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  items: v.array(itemSchema),
  receipts: v.array(receiptSchema),
  createdAt: v.string(),
  updatedAt: v.string(),
});

/** Parse a persisted or renderer-provided review batch into domain values. */
export function parseReviewBatch(
  input: unknown,
): Result<ReviewBatch, InvalidReviewBatch> {
  const raw = v.safeParse(batchSchema, input);
  if (!raw.success) {
    return invalidReviewBatch();
  }

  const sessionId = parseReviewSessionId(raw.output.sessionId);
  const attemptId = parseReviewAttemptId(raw.output.attemptId);
  const createdAt = parseIsoTimestamp(raw.output.createdAt);
  const updatedAt = parseIsoTimestamp(raw.output.updatedAt);
  if (
    sessionId._tag === "err" ||
    attemptId._tag === "err" ||
    createdAt._tag === "err" ||
    updatedAt._tag === "err"
  ) {
    return invalidReviewBatch();
  }

  const items: ReviewBatchItem[] = [];
  const itemIds = new Set<LocalReviewItemId>();
  for (const item of raw.output.items) {
    const parsed = parseItem(item);
    if (parsed._tag === "err" || itemIds.has(parsed.value.id)) {
      return invalidReviewBatch();
    }
    itemIds.add(parsed.value.id);
    items.push(parsed.value);
  }

  const state = parseState(raw.output.state);
  if (state._tag === "err") {
    return state;
  }

  const receipts: RemoteWriteReceipt[] = [];
  for (const receipt of raw.output.receipts) {
    const parsed = parseReceipt(receipt);
    if (parsed._tag === "err") {
      return parsed;
    }
    receipts.push(parsed.value);
  }

  return ok({
    sessionId: sessionId.value,
    attemptId: attemptId.value,
    state: state.value,
    summaryBody: raw.output.summaryBody,
    suggestedEvent: raw.output.suggestedEvent,
    items,
    receipts,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

/** Whether a batch still owns local or incomplete remote work that blocks rerun. */
export function hasActiveReviewBatch(
  batch: Pick<ReviewBatch, "state">,
): boolean {
  return batch.state._tag !== "Submitted";
}

function parseItem(
  item: v.InferOutput<typeof itemSchema>,
): Result<ReviewBatchItem, InvalidReviewBatch> {
  const id = parseLocalReviewItemId(item.id);
  if (id._tag === "err") {
    return invalidReviewBatch();
  }

  if (item._tag === "ThreadReply" || item._tag === "ThreadState") {
    const threadId = parseGitHubThreadId(item.threadId);
    if (threadId._tag === "err") {
      return invalidReviewBatch();
    }
    return item._tag === "ThreadReply"
      ? ok({
          _tag: "ThreadReply",
          id: id.value,
          threadId: threadId.value,
          body: item.body,
          include: item.include,
        })
      : ok({
          _tag: "ThreadState",
          id: id.value,
          threadId: threadId.value,
          action: item.action,
          include: item.include,
        });
  }

  const path = parseRepoRelativePath(item.anchor.path);
  const findingId =
    item.findingId === undefined ? undefined : parseFindingId(item.findingId);
  if (
    path._tag === "err" ||
    item.anchor.line < item.anchor.startLine ||
    (findingId !== undefined && findingId._tag === "err") ||
    (item.source === "finding") !== (findingId !== undefined)
  ) {
    return invalidReviewBatch();
  }

  return ok({
    _tag: "InlineComment",
    id: id.value,
    source: item.source,
    ...(findingId === undefined ? {} : { findingId: findingId.value }),
    anchor: {
      path: path.value,
      startLine: item.anchor.startLine,
      line: item.anchor.line,
      side: item.anchor.side,
    },
    body: item.body,
    include: item.include,
    postability: item.postability,
  });
}

function parseState(
  state: v.InferOutput<typeof stateSchema>,
): Result<ReviewBatchState, InvalidReviewBatch> {
  if (
    state._tag === "Local" ||
    state._tag === "PendingReview" ||
    state._tag === "Submitted"
  ) {
    return ok(state);
  }

  const operation = parseOperation(state.operation);
  if (operation._tag === "err") {
    return operation;
  }
  return state._tag === "Applying"
    ? ok({ _tag: "Applying", operation: operation.value })
    : ok({
        _tag: "PartialFailure",
        operation: operation.value,
        failure: state.failure,
      });
}

function parseOperation(
  operation: v.InferOutput<typeof operationSchema>,
): Result<BatchOperation, InvalidReviewBatch> {
  if (operation._tag === "CreatePendingReview") {
    const itemIds: LocalReviewItemId[] = [];
    for (const value of operation.itemIds) {
      const itemId = parseLocalReviewItemId(value);
      if (itemId._tag === "err") {
        return invalidReviewBatch();
      }
      itemIds.push(itemId.value);
    }
    return itemIds.length === 0
      ? invalidReviewBatch()
      : ok({ _tag: "CreatePendingReview", itemIds });
  }

  const itemId = parseLocalReviewItemId(operation.itemId);
  if (itemId._tag === "err") {
    return invalidReviewBatch();
  }
  return ok({ _tag: operation._tag, itemId: itemId.value });
}

function parseReceipt(
  receipt: v.InferOutput<typeof receiptSchema>,
): Result<RemoteWriteReceipt, InvalidReviewBatch> {
  if (receipt._tag === "PendingReviewCreated") {
    return ok(receipt);
  }

  const itemId = parseLocalReviewItemId(receipt.itemId);
  if (itemId._tag === "err") {
    return invalidReviewBatch();
  }
  return receipt._tag === "ReplyCreated"
    ? ok({
        _tag: "ReplyCreated",
        itemId: itemId.value,
        commentId: receipt.commentId,
      })
    : ok({
        _tag: "ThreadStateChanged",
        itemId: itemId.value,
        state: receipt.state,
      });
}

function invalidReviewBatch(): Result<never, InvalidReviewBatch> {
  return err({ _tag: "InvalidReviewBatch" });
}
