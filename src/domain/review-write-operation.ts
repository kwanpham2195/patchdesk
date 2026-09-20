import * as v from "valibot";

import {
  parseContentHash,
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  parseGitSha,
  parseIsoTimestamp,
  parseReviewId,
  parseReviewSessionId,
  parseRepoRelativePath,
  parseWorkspaceProfileId,
  type ContentHash,
  type GitHubLogin,
  type GitHubReviewCommentId,
  type GitHubReviewRestId,
  type GitHubThreadId,
  type GitSha,
  type IsoTimestamp,
  type ReviewId,
  type ReviewSessionId,
  type RepoRelativePath,
  type WorkspaceProfileId,
} from "./ids";
import {
  parseRecentReviewWrite,
  recentReviewWriteRecordSchema,
  type RecentReviewWrite,
} from "./recent-review-write";
import { err, ok, type AssertNever, type Result } from "./result";

/** Revision identity that an uncertain Review write remains bound to. */
export type ReviewWriteRevision = {
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
};
/** Failure to parse or legally transition a durable Review write operation. */
export type InvalidReviewWriteOperation = {
  readonly _tag: "InvalidReviewWriteOperation";
};

/** A readonly collection whose type proves that it contains at least one value. */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/** Refine a readonly collection after rejecting the empty case. */
export function parseNonEmptyReadonlyArray<T>(
  input: ReadonlyArray<T>,
): Result<NonEmptyReadonlyArray<T>, "empty"> {
  const [first, ...rest] = input;
  return first === undefined ? err("empty") : ok([first, ...rest]);
}

/** Exact Review write intent persisted before Patchdesk crosses GitHub's write boundary. */
export type ReviewWriteIntent =
  | {
      readonly _tag: "CreateComment";
      readonly expected: ReviewWriteRevision;
      readonly actor: GitHubLogin;
      readonly anchor: {
        readonly path: RepoRelativePath;
        readonly startLine: number;
        readonly line: number;
        readonly side: "new" | "old";
      };
      readonly body: string;
    }
  | {
      readonly _tag: "Reply";
      readonly expected: ReviewWriteRevision;
      readonly actor: GitHubLogin;
      readonly threadId: GitHubThreadId;
      readonly body: string;
    }
  | {
      readonly _tag: "SetThreadState";
      readonly expected: ReviewWriteRevision;
      readonly threadId: GitHubThreadId;
      readonly state: "open" | "resolved";
    }
  | {
      readonly _tag: "EditComment";
      readonly expected: ReviewWriteRevision;
      readonly commentId: GitHubReviewCommentId;
      readonly body: string;
    }
  | {
      readonly _tag: "DeleteComment";
      readonly expected: ReviewWriteRevision;
      readonly commentId: GitHubReviewCommentId;
    }
  | {
      readonly _tag: "EditPublishedComment";
      readonly expected: ReviewWriteRevision;
      readonly commentId: GitHubReviewCommentId;
      readonly body: string;
    }
  | {
      readonly _tag: "DeletePublishedComment";
      readonly expected: ReviewWriteRevision;
      readonly commentId: GitHubReviewCommentId;
    }
  | {
      readonly _tag: "DismissPublishedReview";
      readonly expected: ReviewWriteRevision;
      readonly publishedReviewId: GitHubReviewRestId;
      readonly message: string;
    }
  | {
      readonly _tag: "AddLabels";
      readonly names: NonEmptyReadonlyArray<string>;
    }
  | {
      readonly _tag: "RemoveLabels";
      readonly names: NonEmptyReadonlyArray<string>;
    }
  | {
      readonly _tag: "AddAssignees";
      readonly logins: NonEmptyReadonlyArray<string>;
    }
  | {
      readonly _tag: "RemoveAssignees";
      readonly logins: NonEmptyReadonlyArray<string>;
    }
  | {
      readonly _tag: "RequestReviewers";
      readonly logins: NonEmptyReadonlyArray<string>;
    }
  | {
      readonly _tag: "RemoveReviewers";
      readonly logins: NonEmptyReadonlyArray<string>;
    }
  | { readonly _tag: "SetDraftState"; readonly draft: boolean }
  | { readonly _tag: "SetBaseBranch"; readonly branch: string };

/** Every `ReviewWriteIntent` tag; the renderer recovery picklist and the workbench projection are built from this list. */
export const REVIEW_WRITE_INTENT_TAGS = [
  "CreateComment",
  "Reply",
  "SetThreadState",
  "EditComment",
  "DeleteComment",
  "EditPublishedComment",
  "DeletePublishedComment",
  "DismissPublishedReview",
  "AddLabels",
  "RemoveLabels",
  "AddAssignees",
  "RemoveAssignees",
  "RequestReviewers",
  "RemoveReviewers",
  "SetDraftState",
  "SetBaseBranch",
] as const satisfies ReadonlyArray<ReviewWriteIntent["_tag"]>;

/** A `ReviewWriteIntent` tag drawn from `REVIEW_WRITE_INTENT_TAGS`. */
export type ReviewWriteIntentTag = (typeof REVIEW_WRITE_INTENT_TAGS)[number];

/**
 * Fails to compile when `ReviewWriteIntent` gains a member that
 * `REVIEW_WRITE_INTENT_TAGS` omits.
 *
 * @public Nothing imports this; the compiler is its only reader.
 */
export type UnlistedReviewWriteIntentTag = AssertNever<
  Exclude<ReviewWriteIntent["_tag"], ReviewWriteIntentTag>
>;

/** One durable, per-Review direct-conversation write and its recovery state. */
export type ReviewWriteOperation = {
  readonly schemaVersion: 1;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly intent: ReviewWriteIntent;
  readonly state:
    | { readonly _tag: "Requested" }
    | {
        readonly _tag: "OutcomeUnknown";
        readonly resolution: "check_required" | "manual_resolution_required";
      }
    | {
        readonly _tag: "Confirmed";
        readonly receipt?: RecentReviewWrite;
      };
  readonly startedAt: IsoTimestamp;
};

const expectedSchema = v.strictObject({
  sessionId: v.string(),
  headSha: v.string(),
  patchHash: v.string(),
});
const nonEmptyStringArraySchema = v.pipe(
  v.tupleWithRest([v.string()], v.string()),
  v.readonly(),
);

const nonEmptyLabelNameArraySchema = v.pipe(
  v.tupleWithRest(
    [v.pipe(v.string(), v.minLength(1))],
    v.pipe(v.string(), v.minLength(1)),
  ),
  v.readonly(),
);

const intentSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("CreateComment"),
    expected: expectedSchema,
    actor: v.string(),
    anchor: v.strictObject({
      path: v.string(),
      startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
      line: v.pipe(v.number(), v.integer(), v.minValue(1)),
      side: v.picklist(["new", "old"]),
    }),
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("Reply"),
    expected: expectedSchema,
    actor: v.string(),
    threadId: v.string(),
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("SetThreadState"),
    expected: expectedSchema,
    threadId: v.string(),
    state: v.picklist(["open", "resolved"]),
  }),
  v.strictObject({
    _tag: v.literal("EditComment"),
    expected: expectedSchema,
    commentId: v.string(),
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("DeleteComment"),
    expected: expectedSchema,
    commentId: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("EditPublishedComment"),
    expected: expectedSchema,
    commentId: v.string(),
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("DeletePublishedComment"),
    expected: expectedSchema,
    commentId: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("DismissPublishedReview"),
    expected: expectedSchema,
    publishedReviewId: v.string(),
    message: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("AddLabels"),
    names: nonEmptyLabelNameArraySchema,
  }),
  v.strictObject({
    _tag: v.literal("RemoveLabels"),
    names: nonEmptyLabelNameArraySchema,
  }),
  v.strictObject({
    _tag: v.literal("AddAssignees"),
    logins: nonEmptyStringArraySchema,
  }),
  v.strictObject({
    _tag: v.literal("RemoveAssignees"),
    logins: nonEmptyStringArraySchema,
  }),
  v.strictObject({
    _tag: v.literal("RequestReviewers"),
    logins: nonEmptyStringArraySchema,
  }),
  v.strictObject({
    _tag: v.literal("RemoveReviewers"),
    logins: nonEmptyStringArraySchema,
  }),
  v.strictObject({ _tag: v.literal("SetDraftState"), draft: v.boolean() }),
  v.strictObject({
    _tag: v.literal("SetBaseBranch"),
    branch: v.pipe(v.string(), v.minLength(1)),
  }),
]);

/**
 * Fails to compile when `intentSchema` and `REVIEW_WRITE_INTENT_TAGS` disagree
 * in either direction, so a listed tag cannot be persisted without a variant.
 *
 * @public Nothing imports this; the compiler is its only reader.
 */
export type UnlistedIntentSchemaTag = AssertNever<
  | Exclude<v.InferOutput<typeof intentSchema>["_tag"], ReviewWriteIntentTag>
  | Exclude<ReviewWriteIntentTag, v.InferOutput<typeof intentSchema>["_tag"]>
>;

const operationSchema = v.strictObject({
  schemaVersion: v.literal(1),
  profileId: v.string(),
  reviewId: v.string(),
  sessionId: v.string(),
  intent: intentSchema,
  state: v.variant("_tag", [
    v.strictObject({ _tag: v.literal("Requested") }),
    v.strictObject({
      _tag: v.literal("OutcomeUnknown"),
      resolution: v.picklist(["check_required", "manual_resolution_required"]),
    }),
    v.strictObject({
      _tag: v.literal("Confirmed"),
      receipt: v.optional(recentReviewWriteRecordSchema),
    }),
  ]),
  startedAt: v.string(),
});

/** The persisted form of an operation record; the store writes this, parseReviewWriteOperation reads it. */
export type PersistedReviewWriteOperation = v.InferOutput<
  typeof operationSchema
>;

/** Parse a persisted operation, including every branded identity at the storage boundary. */
export function parseReviewWriteOperation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the persisted operation's I/O boundary parser and immediately runs the owned strict schema.
  input: unknown,
): Result<ReviewWriteOperation, InvalidReviewWriteOperation> {
  const parsed = v.safeParse(operationSchema, input);
  if (!parsed.success) return invalid();
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const sessionId = parseReviewSessionId(parsed.output.sessionId);
  const startedAt = parseIsoTimestamp(parsed.output.startedAt);
  const expected =
    "expected" in parsed.output.intent
      ? parseExpectedRevision(parsed.output.intent.expected)
      : undefined;
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    sessionId._tag === "err" ||
    startedAt._tag === "err" ||
    (expected !== undefined &&
      (expected._tag === "err" || sessionId.value !== expected.value.sessionId))
  )
    return invalid();
  const intent = parseIntent(
    parsed.output.intent,
    expected?._tag === "ok" ? expected.value : undefined,
  );
  if (intent._tag === "err") return intent;
  const state = parseState(parsed.output.state);
  if (state === undefined) return invalid();
  return ok({
    schemaVersion: 1,
    profileId: profileId.value,
    reviewId: reviewId.value,
    sessionId: sessionId.value,
    intent: intent.value,
    state,
    startedAt: startedAt.value,
  });
}

type ParsedIntent = v.InferOutput<typeof intentSchema>;
type ParsedState = v.InferOutput<typeof operationSchema>["state"];

function parseIntent(
  intent: ParsedIntent,
  expected: ReviewWriteRevision | undefined,
): Result<ReviewWriteIntent, InvalidReviewWriteOperation> {
  switch (intent._tag) {
    case "CreateComment": {
      if (expected === undefined) return invalid();
      const actor = parseGitHubLogin(intent.actor);
      const path = parseRepoRelativePath(intent.anchor.path);
      if (
        actor._tag === "err" ||
        path._tag === "err" ||
        intent.anchor.line < intent.anchor.startLine
      )
        return invalid();
      return ok({
        ...intent,
        expected,
        actor: actor.value,
        anchor: { ...intent.anchor, path: path.value },
      });
    }
    case "Reply": {
      if (expected === undefined) return invalid();
      const actor = parseGitHubLogin(intent.actor);
      const threadId = parseGitHubThreadId(intent.threadId);
      return actor._tag === "err" || threadId._tag === "err"
        ? invalid()
        : ok({
            ...intent,
            expected,
            actor: actor.value,
            threadId: threadId.value,
          });
    }
    case "SetThreadState": {
      if (expected === undefined) return invalid();
      const threadId = parseGitHubThreadId(intent.threadId);
      return threadId._tag === "err"
        ? invalid()
        : ok({ ...intent, expected, threadId: threadId.value });
    }
    case "EditComment":
    case "DeleteComment":
    case "EditPublishedComment":
    case "DeletePublishedComment": {
      if (expected === undefined) return invalid();
      const commentId = parseGitHubReviewCommentId(intent.commentId);
      return commentId._tag === "err"
        ? invalid()
        : ok({ ...intent, expected, commentId: commentId.value });
    }
    case "DismissPublishedReview": {
      if (expected === undefined) return invalid();
      const publishedReviewId = parseGitHubReviewRestId(
        intent.publishedReviewId,
      );
      return publishedReviewId._tag === "err"
        ? invalid()
        : ok({
            ...intent,
            expected,
            publishedReviewId: publishedReviewId.value,
          });
    }
    case "AddLabels":
    case "RemoveLabels":
      return ok(intent);
    case "AddAssignees":
    case "RemoveAssignees":
    case "RequestReviewers":
    case "RemoveReviewers": {
      const logins = intent.logins.map(parseGitHubLogin);
      if (logins.some((login) => login._tag === "err")) return invalid();
      return ok(intent);
    }
    case "SetDraftState":
    case "SetBaseBranch":
      return ok(intent);
  }
}

function parseExpectedRevision(
  expected: v.InferOutput<typeof expectedSchema>,
): Result<ReviewWriteRevision, InvalidReviewWriteOperation> {
  const sessionId = parseReviewSessionId(expected.sessionId);
  const headSha = parseGitSha(expected.headSha);
  const patchHash = parseContentHash(expected.patchHash);
  if (
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
  )
    return invalid();
  return ok({
    sessionId: sessionId.value,
    headSha: headSha.value,
    patchHash: patchHash.value,
  });
}

function parseState(
  state: ParsedState,
): ReviewWriteOperation["state"] | undefined {
  if (state._tag === "Requested") return state;
  if (state._tag === "OutcomeUnknown") return state;
  if (state.receipt === undefined) return { _tag: "Confirmed" };
  const receipt = parseRecentReviewWrite(state.receipt);
  return receipt._tag === "err"
    ? undefined
    : { _tag: "Confirmed", receipt: receipt.value };
}

/** Advance a requested write immediately before its GitHub mutation. */
export function markReviewWriteOutcomeUnknown(
  operation: ReviewWriteOperation,
  resolution:
    | "check_required"
    | "manual_resolution_required" = "check_required",
): Result<ReviewWriteOperation, InvalidReviewWriteOperation> {
  return operation.state._tag === "Requested"
    ? ok({ ...operation, state: { _tag: "OutcomeUnknown", resolution } })
    : invalid();
}

/** Update recovery resolution only while a write remains outcome-unknown. */
export function setReviewWriteResolution(
  operation: ReviewWriteOperation,
  resolution: "check_required" | "manual_resolution_required",
): Result<ReviewWriteOperation, InvalidReviewWriteOperation> {
  return operation.state._tag === "OutcomeUnknown"
    ? ok({ ...operation, state: { _tag: "OutcomeUnknown", resolution } })
    : invalid();
}

/** Record durable confirmation before the command reports success. */
export function confirmReviewWrite(
  operation: ReviewWriteOperation,
  receipt?: RecentReviewWrite,
): Result<ReviewWriteOperation, InvalidReviewWriteOperation> {
  return operation.state._tag === "OutcomeUnknown"
    ? ok({
        ...operation,
        state:
          receipt === undefined
            ? { _tag: "Confirmed" }
            : { _tag: "Confirmed", receipt },
      })
    : invalid();
}

function invalid(): Result<never, InvalidReviewWriteOperation> {
  return err({ _tag: "InvalidReviewWriteOperation" });
}
