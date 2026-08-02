import * as v from "valibot";

import {
  parseFindingId,
  parseGitHubThreadId,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parseLocalReviewItemId,
  parseRepoRelativePath,
  parseReviewAttemptId,
  parseReviewSessionId,
  type FindingId,
  type GitHubThreadId,
  type GitSha,
  type InsightRunId,
  type IsoTimestamp,
  type LocalReviewItemId,
  type RepoRelativePath,
  type ReviewAttemptId,
  type ReviewSessionId,
} from "./ids";
import { err, ok, type Result } from "./result";

/** The GitHub review verdict submitted after a pending review is ready. */
export type GitHubReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

/** Safe error returned by an attempted GitHub write. */
export type GitHubWriteFailure = {
  readonly _tag: "GitHubWriteFailure";
  readonly category: "auth" | "rejected" | "unavailable";
  readonly message: string;
};

/** Whether an inline comment can currently be sent to GitHub. */
export type Postability =
  | "postable"
  | "already_reported"
  | "invalid_line"
  | "stale_sha"
  | "api_rejected"
  | "needs_attention";

/** A side-aware line or range in one repository-relative file. */
export type ReviewAnchor = {
  readonly path: RepoRelativePath;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
};

/** Exact diff context retained for conservative automatic carry-forward. */
export type ReviewAnchorFingerprint = {
  readonly path: RepoRelativePath;
  readonly side: "new" | "old";
  readonly startLine: number;
  readonly line: number;
  readonly selectedLines: ReadonlyArray<string>;
  readonly before: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
};

/** Preserves an inline draft that cannot be safely mapped to the current diff. */
export type ReviewAnchorAttention = {
  readonly reason: "missing" | "ambiguous" | "fingerprint_missing";
  readonly originalAnchor: ReviewAnchor;
  readonly originalFingerprint?: ReviewAnchorFingerprint;
};

/** Records that a local action was carried from an older immutable snapshot. */
export type ReviewItemCarryForward = {
  readonly sourceSessionId: ReviewSessionId;
  readonly sourceHeadSha: GitSha;
};

/** Records whether a local item started with a human or an optional model run. */
export type ReviewItemProvenance =
  | { readonly _tag: "human" }
  | { readonly _tag: "model"; readonly attemptId: ReviewAttemptId }
  | { readonly _tag: "insight"; readonly runId: InsightRunId };

/** One local action included in or excluded from a review batch. */
export type ReviewBatchItem =
  | {
      readonly _tag: "InlineComment";
      readonly id: LocalReviewItemId;
      readonly provenance: ReviewItemProvenance;
      readonly source: "finding" | "manual";
      readonly findingId?: FindingId;
      readonly anchor: ReviewAnchor;
      readonly fingerprint?: ReviewAnchorFingerprint;
      readonly body: string;
      readonly include: boolean;
      readonly postability: Postability;
      readonly attention?: ReviewAnchorAttention;
      readonly carriedFrom?: ReviewItemCarryForward;
    }
  | {
      readonly _tag: "GeneralComment";
      readonly id: LocalReviewItemId;
      readonly provenance: ReviewItemProvenance;
      readonly source: "finding" | "manual";
      readonly findingId?: FindingId;
      readonly body: string;
      readonly include: boolean;
      readonly carriedFrom?: ReviewItemCarryForward;
    }
  | {
      readonly _tag: "ThreadReply";
      readonly id: LocalReviewItemId;
      readonly provenance: ReviewItemProvenance;
      readonly threadId: GitHubThreadId;
      readonly body: string;
      readonly include: boolean;
      readonly carriedFrom?: ReviewItemCarryForward;
    }
  | {
      readonly _tag: "ThreadState";
      readonly id: LocalReviewItemId;
      readonly provenance: ReviewItemProvenance;
      readonly threadId: GitHubThreadId;
      readonly action: "resolve" | "reopen";
      readonly include: boolean;
      readonly carriedFrom?: ReviewItemCarryForward;
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
    }
  | { readonly _tag: "Completed" };

/** A durable receipt proving one remote write completed successfully. */
export type RemoteWriteReceipt =
  | {
      readonly _tag: "PendingReviewCreated";
      readonly reviewId: string;
      readonly itemIds: ReadonlyArray<LocalReviewItemId>;
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
  /** Present only while the legacy attempt-owned batch shape is being read. */
  readonly attemptId?: ReviewAttemptId;
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
const provenanceSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("human") }),
  v.strictObject({ _tag: v.literal("model"), attemptId: v.string() }),
  v.strictObject({ _tag: v.literal("insight"), runId: v.string() }),
]);

const carriedFromSchema = v.strictObject({
  sourceSessionId: v.string(),
  sourceHeadSha: v.string(),
});

const anchorSchema = v.strictObject({
  path: v.string(),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  side: v.picklist(["new", "old"]),
});

const fingerprintSchema = v.strictObject({
  path: v.string(),
  side: v.picklist(["new", "old"]),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  selectedLines: v.pipe(v.array(v.string()), v.maxLength(8)),
  before: v.pipe(v.array(v.string()), v.maxLength(2)),
  after: v.pipe(v.array(v.string()), v.maxLength(2)),
});

const attentionSchema = v.strictObject({
  reason: v.picklist(["missing", "ambiguous", "fingerprint_missing"]),
  originalAnchor: anchorSchema,
  originalFingerprint: v.optional(fingerprintSchema),
});

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
  v.strictObject({ _tag: v.literal("Completed") }),
]);

const itemSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("InlineComment"),
    id: localReviewItemIdSchema,
    provenance: v.optional(provenanceSchema),
    source: v.picklist(["finding", "manual"]),
    findingId: v.optional(v.string()),
    anchor: anchorSchema,
    fingerprint: v.optional(fingerprintSchema),
    body: v.string(),
    include: v.boolean(),
    attention: v.optional(attentionSchema),
    carriedFrom: v.optional(carriedFromSchema),
    postability: v.picklist([
      "postable",
      "already_reported",
      "invalid_line",
      "stale_sha",
      "api_rejected",
      "needs_attention",
    ]),
  }),
  v.strictObject({
    _tag: v.literal("GeneralComment"),
    id: localReviewItemIdSchema,
    provenance: v.optional(provenanceSchema),
    source: v.picklist(["finding", "manual"]),
    findingId: v.optional(v.string()),
    body: v.string(),
    include: v.boolean(),
    carriedFrom: v.optional(carriedFromSchema),
  }),
  v.strictObject({
    _tag: v.literal("ThreadReply"),
    id: localReviewItemIdSchema,
    provenance: v.optional(provenanceSchema),
    threadId: githubThreadIdSchema,
    body: v.string(),
    include: v.boolean(),
    carriedFrom: v.optional(carriedFromSchema),
  }),
  v.strictObject({
    _tag: v.literal("ThreadState"),
    id: localReviewItemIdSchema,
    provenance: v.optional(provenanceSchema),
    threadId: githubThreadIdSchema,
    action: v.picklist(["resolve", "reopen"]),
    include: v.boolean(),
    carriedFrom: v.optional(carriedFromSchema),
  }),
]);

const receiptSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("PendingReviewCreated"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
    itemIds: v.array(localReviewItemIdSchema),
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
  attemptId: v.optional(v.string()),
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
  const attemptId =
    raw.output.attemptId === undefined
      ? undefined
      : parseReviewAttemptId(raw.output.attemptId);
  const createdAt = parseIsoTimestamp(raw.output.createdAt);
  const updatedAt = parseIsoTimestamp(raw.output.updatedAt);
  if (
    sessionId._tag === "err" ||
    (attemptId !== undefined && attemptId._tag === "err") ||
    createdAt._tag === "err" ||
    updatedAt._tag === "err"
  ) {
    return invalidReviewBatch();
  }

  const items: ReviewBatchItem[] = [];
  const itemIds = new Set<LocalReviewItemId>();
  for (const item of raw.output.items) {
    const parsed = parseItem(
      item,
      attemptId === undefined ? undefined : attemptId.value,
    );
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
  if (!hasCoherentRelationships(state.value, items, receipts)) {
    return invalidReviewBatch();
  }

  return ok({
    sessionId: sessionId.value,
    ...(attemptId === undefined ? {} : { attemptId: attemptId.value }),
    state: state.value,
    summaryBody: raw.output.summaryBody,
    suggestedEvent: raw.output.suggestedEvent,
    items,
    receipts,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

/** Create the editable, snapshot-owned batch before any optional model run. */
export function createEmptyReviewBatch(input: {
  readonly sessionId: ReviewSessionId;
  readonly createdAt: IsoTimestamp;
}): ReviewBatch {
  return {
    sessionId: input.sessionId,
    state: { _tag: "Local" },
    summaryBody: "",
    suggestedEvent: "COMMENT",
    items: [],
    receipts: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Whether a batch has remote-write evidence that must block a model rerun. */
export function hasActiveReviewBatch(
  batch: Pick<ReviewBatch, "state">,
): boolean {
  return (
    batch.state._tag === "Applying" ||
    batch.state._tag === "PendingReview" ||
    batch.state._tag === "Submitted" ||
    (batch.state._tag === "PartialFailure" &&
      batch.state.failure.category === "outcome_unknown")
  );
}

function parseItem(
  item: v.InferOutput<typeof itemSchema>,
  legacyAttemptId: ReviewAttemptId | undefined,
): Result<ReviewBatchItem, InvalidReviewBatch> {
  const id = parseLocalReviewItemId(item.id);
  if (id._tag === "err") {
    return invalidReviewBatch();
  }

  if (item._tag === "GeneralComment") {
    const findingId = item.findingId === undefined ? undefined : parseFindingId(item.findingId);
    const provenance = parseProvenance(item.provenance, legacyAttemptId, item.source === "finding" ? "model" : "human");
    const carriedFrom = parseCarryForward(item.carriedFrom);
    if (findingId !== undefined && findingId._tag === "err" || provenance._tag === "err" || carriedFrom._tag === "err" || (item.source === "finding") !== (findingId !== undefined) || (item.source === "finding") !== (provenance._tag === "ok" && (provenance.value._tag === "model" || provenance.value._tag === "insight"))) return invalidReviewBatch();
    return ok({
      _tag: "GeneralComment",
      id: id.value,
      provenance: provenance.value,
      source: item.source,
      ...(findingId === undefined ? {} : { findingId: findingId.value }),
      body: item.body,
      include: item.include,
      ...(carriedFrom.value === undefined ? {} : { carriedFrom: carriedFrom.value }),
    });
  }

  if (item._tag === "ThreadReply" || item._tag === "ThreadState") {
    const threadId = parseGitHubThreadId(item.threadId);
    if (threadId._tag === "err") {
      return invalidReviewBatch();
    }
    const provenance = parseProvenance(item.provenance, legacyAttemptId, "human");
    const carriedFrom = parseCarryForward(item.carriedFrom);
    if (provenance._tag === "err" || carriedFrom._tag === "err") return invalidReviewBatch();
    return item._tag === "ThreadReply"
      ? ok({
          _tag: "ThreadReply",
          id: id.value,
          provenance: provenance.value,
          threadId: threadId.value,
          body: item.body,
          include: item.include,
          ...(carriedFrom.value === undefined ? {} : { carriedFrom: carriedFrom.value }),
        })
      : ok({
          _tag: "ThreadState",
          id: id.value,
          provenance: provenance.value,
          threadId: threadId.value,
          action: item.action,
          include: item.include,
          ...(carriedFrom.value === undefined ? {} : { carriedFrom: carriedFrom.value }),
        });
  }

  const path = parseRepoRelativePath(item.anchor.path);
  const findingId =
    item.findingId === undefined ? undefined : parseFindingId(item.findingId);
  const provenance = parseProvenance(
    item.provenance,
    legacyAttemptId,
    item.source === "finding" ? "model" : "human",
  );
  const carriedFrom = parseCarryForward(item.carriedFrom);
  const attention = item.attention === undefined
    ? ok(undefined)
    : parseAttention(item.attention);
  const fingerprintPath = item.fingerprint === undefined
    ? undefined
    : parseRepoRelativePath(item.fingerprint.path);
  if (
    path._tag === "err" ||
    item.anchor.line < item.anchor.startLine ||
    (findingId !== undefined && findingId._tag === "err") ||
    (item.source === "finding") !== (findingId !== undefined) ||
    provenance._tag === "err" ||
    carriedFrom._tag === "err" ||
    attention._tag === "err" ||
    (fingerprintPath !== undefined && fingerprintPath._tag === "err") ||
    (item.fingerprint !== undefined && fingerprintPath?.value !== path.value) ||
    (item.fingerprint !== undefined && item.fingerprint.line < item.fingerprint.startLine) ||
    (item.fingerprint !== undefined && item.fingerprint.startLine !== item.anchor.startLine) ||
    (item.fingerprint !== undefined && item.fingerprint.line !== item.anchor.line) ||
    (item.fingerprint !== undefined && item.fingerprint.side !== item.anchor.side) ||
    (item.fingerprint !== undefined && item.fingerprint.selectedLines.length !== item.anchor.line - item.anchor.startLine + 1) ||
    (item.source === "finding") !== (provenance.value._tag === "model" || provenance.value._tag === "insight") ||
    (item.postability === "needs_attention") !== (attention.value !== undefined)
  ) {
    return invalidReviewBatch();
  }

  return ok({
    _tag: "InlineComment",
    id: id.value,
    provenance: provenance.value,
    source: item.source,
    ...(findingId === undefined ? {} : { findingId: findingId.value }),
    anchor: {
      path: path.value,
      startLine: item.anchor.startLine,
      line: item.anchor.line,
      side: item.anchor.side,
    },
    ...(item.fingerprint === undefined ? {} : {
      fingerprint: {
        path: path.value,
        side: item.fingerprint.side,
        startLine: item.fingerprint.startLine,
        line: item.fingerprint.line,
        selectedLines: item.fingerprint.selectedLines,
        before: item.fingerprint.before,
        after: item.fingerprint.after,
      },
    }),
    body: item.body,
    include: item.include,
    postability: item.postability,
    ...(attention.value === undefined ? {} : { attention: attention.value }),
    ...(carriedFrom.value === undefined ? {} : { carriedFrom: carriedFrom.value }),
  });
}

function parseAttention(
  input: v.InferOutput<typeof attentionSchema>,
): Result<ReviewAnchorAttention, InvalidReviewBatch> {
  const path = parseRepoRelativePath(input.originalAnchor.path);
  const fingerprintPath = input.originalFingerprint === undefined
    ? undefined
    : parseRepoRelativePath(input.originalFingerprint.path);
  if (
    path._tag === "err" ||
    (fingerprintPath !== undefined && fingerprintPath._tag === "err") ||
    input.originalAnchor.line < input.originalAnchor.startLine ||
    (input.originalFingerprint !== undefined && (
      fingerprintPath?.value !== path.value ||
      input.originalFingerprint.line < input.originalFingerprint.startLine ||
      input.originalFingerprint.startLine !== input.originalAnchor.startLine ||
      input.originalFingerprint.line !== input.originalAnchor.line ||
      input.originalFingerprint.side !== input.originalAnchor.side ||
      input.originalFingerprint.selectedLines.length !== input.originalAnchor.line - input.originalAnchor.startLine + 1
    ))
  ) {
    return invalidReviewBatch();
  }
  return ok({
    reason: input.reason,
    originalAnchor: {
      path: path.value,
      startLine: input.originalAnchor.startLine,
      line: input.originalAnchor.line,
      side: input.originalAnchor.side,
    },
    ...(input.originalFingerprint === undefined ? {} : {
      originalFingerprint: {
        path: path.value,
        side: input.originalFingerprint.side,
        startLine: input.originalFingerprint.startLine,
        line: input.originalFingerprint.line,
        selectedLines: input.originalFingerprint.selectedLines,
        before: input.originalFingerprint.before,
        after: input.originalFingerprint.after,
      },
    }),
  });
}

function parseCarryForward(
  input: v.InferOutput<typeof carriedFromSchema> | undefined,
): Result<ReviewItemCarryForward | undefined, InvalidReviewBatch> {
  if (input === undefined) return ok(undefined);
  const sourceSessionId = parseReviewSessionId(input.sourceSessionId);
  const sourceHeadSha = parseGitSha(input.sourceHeadSha);
  return sourceSessionId._tag === "err" || sourceHeadSha._tag === "err"
    ? invalidReviewBatch()
    : ok({ sourceSessionId: sourceSessionId.value, sourceHeadSha: sourceHeadSha.value });
}

function parseProvenance(
  input: v.InferOutput<typeof provenanceSchema> | undefined,
  legacyAttemptId: ReviewAttemptId | undefined,
  legacyDefault: "human" | "model",
): Result<ReviewItemProvenance, InvalidReviewBatch> {
  if (input === undefined) {
    return legacyDefault === "human"
      ? ok({ _tag: "human" })
      : legacyAttemptId === undefined
        ? invalidReviewBatch()
        : ok({ _tag: "model", attemptId: legacyAttemptId });
  }
  if (input._tag === "human") return ok(input);
  if (input._tag === "insight") {
    const runId = parseInsightRunId(input.runId);
    return runId._tag === "err"
      ? invalidReviewBatch()
      : ok({ _tag: "insight", runId: runId.value });
  }
  const attemptId = parseReviewAttemptId(input.attemptId);
  return attemptId._tag === "err"
    ? invalidReviewBatch()
    : ok({ _tag: "model", attemptId: attemptId.value });
}

function parseState(
  state: v.InferOutput<typeof stateSchema>,
): Result<ReviewBatchState, InvalidReviewBatch> {
  if (
    state._tag === "Local" ||
    state._tag === "PendingReview" ||
    state._tag === "Submitted" ||
    state._tag === "Completed"
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
    const itemIds: LocalReviewItemId[] = [];
    for (const value of receipt.itemIds) {
      const itemId = parseLocalReviewItemId(value);
      if (itemId._tag === "err") {
        return invalidReviewBatch();
      }
      itemIds.push(itemId.value);
    }
    return ok({
      _tag: "PendingReviewCreated",
      reviewId: receipt.reviewId,
      itemIds,
    });
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

function hasCoherentRelationships(
  state: ReviewBatchState,
  items: ReadonlyArray<ReviewBatchItem>,
  receipts: ReadonlyArray<RemoteWriteReceipt>,
): boolean {
  const itemById = new Map(items.map((item) => [item.id, item]));
  if (
    (state._tag === "Applying" || state._tag === "PartialFailure") &&
    !operationReferencesIncludedItems(state.operation, itemById)
  ) {
    return false;
  }

  const completedOperationKeys: string[] = [];
  const uniqueCompletedOperationKeys = new Set<string>();
  for (const receipt of receipts) {
    const key = receiptOperationKey(receipt, itemById);
    if (key === undefined || uniqueCompletedOperationKeys.has(key)) {
      return false;
    }
    uniqueCompletedOperationKeys.add(key);
    completedOperationKeys.push(key);
  }

  if (state._tag === "Local") {
    return receipts.length === 0;
  }
  const plannedOperationKeys = plannedOperationKeysFor(items);
  if (state._tag === "Applying" || state._tag === "PartialFailure") {
    const currentOperationIndex = plannedOperationKeys.indexOf(
      operationKey(state.operation),
    );
    return (
      currentOperationIndex === completedOperationKeys.length &&
      completedOperationKeys.every(
        (key, index) => plannedOperationKeys[index] === key,
      )
    );
  }

  if (state._tag === "Completed") {
    return (
      plannedOperationKeys.length > 0 &&
      !plannedOperationKeys.includes("pending-review") &&
      isExactCompletedPlan(plannedOperationKeys, completedOperationKeys)
    );
  }

  const pendingReviewReceipt = receipts.find(
    (receipt): receipt is Extract<
      RemoteWriteReceipt,
      { readonly _tag: "PendingReviewCreated" }
    > => receipt._tag === "PendingReviewCreated",
  );
  if (
    pendingReviewReceipt === undefined ||
    pendingReviewReceipt.reviewId !== state.reviewId
  ) {
    return false;
  }

  return (
    plannedOperationKeys.length > 0 &&
    isExactCompletedPlan(plannedOperationKeys, completedOperationKeys)
  );
}

function isExactCompletedPlan(
  plannedOperationKeys: ReadonlyArray<string>,
  completedOperationKeys: ReadonlyArray<string>,
): boolean {
  return (
    plannedOperationKeys.length === completedOperationKeys.length &&
    plannedOperationKeys.every(
      (key, index) => completedOperationKeys[index] === key,
    )
  );
}

function operationReferencesIncludedItems(
  operation: BatchOperation,
  itemById: ReadonlyMap<LocalReviewItemId, ReviewBatchItem>,
): boolean {
  if (operation._tag === "CreatePendingReview") {
    return referencesExactlyIncludedInlineComments(operation.itemIds, itemById);
  }

  const item = itemById.get(operation.itemId);
  return operation._tag === "Reply"
    ? item?._tag === "ThreadReply" && item.include
    : item?._tag === "ThreadState" && item.include;
}

function receiptOperationKey(
  receipt: RemoteWriteReceipt,
  itemById: ReadonlyMap<LocalReviewItemId, ReviewBatchItem>,
): string | undefined {
  if (receipt._tag === "PendingReviewCreated") {
    return referencesExactlyIncludedInlineComments(receipt.itemIds, itemById)
      ? "pending-review"
      : undefined;
  }

  const item = itemById.get(receipt.itemId);
  if (receipt._tag === "ReplyCreated") {
    return item?._tag === "ThreadReply" && item.include
      ? `reply:${item.id}`
      : undefined;
  }
  if (item?._tag !== "ThreadState" || !item.include) {
    return undefined;
  }
  const expectedState = item.action === "resolve" ? "resolved" : "open";
  return receipt.state === expectedState
    ? `thread-state:${item.id}`
    : undefined;
}

function referencesExactlyIncludedInlineComments(
  itemIds: ReadonlyArray<LocalReviewItemId>,
  itemById: ReadonlyMap<LocalReviewItemId, ReviewBatchItem>,
): boolean {
  const includedInlineItemIds = new Set(
    [...itemById.values()].flatMap((item) =>
      item._tag === "InlineComment" && item.include ? [item.id] : [],
    ),
  );
  const referencedItemIds = new Set(itemIds);
  return (
    includedInlineItemIds.size > 0 &&
    referencedItemIds.size === itemIds.length &&
    referencedItemIds.size === includedInlineItemIds.size &&
    [...includedInlineItemIds].every((itemId) => referencedItemIds.has(itemId))
  );
}

function operationKey(operation: BatchOperation): string {
  if (operation._tag === "CreatePendingReview") {
    return "pending-review";
  }
  return operation._tag === "Reply"
    ? `reply:${operation.itemId}`
    : `thread-state:${operation.itemId}`;
}

function plannedOperationKeysFor(
  items: ReadonlyArray<ReviewBatchItem>,
): ReadonlyArray<string> {
  const keys: string[] = [];
  if (
    items.some((item) => item._tag === "InlineComment" && item.include)
  ) {
    keys.push("pending-review");
  }
  for (const item of items) {
    if (!item.include) {
      continue;
    }
    if (item._tag === "ThreadReply") {
      keys.push(`reply:${item.id}`);
    } else if (item._tag === "ThreadState") {
      keys.push(`thread-state:${item.id}`);
    }
  }
  return keys;
}

function invalidReviewBatch(): Result<never, InvalidReviewBatch> {
  return err({ _tag: "InvalidReviewBatch" });
}
