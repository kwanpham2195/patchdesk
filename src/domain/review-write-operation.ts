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
import type { RecentReviewWrite } from "./recent-review-write";
import { err, ok, type Result } from "./result";

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
  | { readonly _tag: "AddLabels"; readonly names: ReadonlyArray<string> }
  | { readonly _tag: "RemoveLabels"; readonly names: ReadonlyArray<string> }
  | {
      readonly _tag: "AddAssignees";
      readonly logins: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "RemoveAssignees";
      readonly logins: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "RequestReviewers";
      readonly logins: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "RemoveReviewers";
      readonly logins: ReadonlyArray<string>;
    };

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
    names: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("RemoveLabels"),
    names: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("AddAssignees"),
    logins: v.pipe(v.array(v.string()), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("RemoveAssignees"),
    logins: v.pipe(v.array(v.string()), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("RequestReviewers"),
    logins: v.pipe(v.array(v.string()), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("RemoveReviewers"),
    logins: v.pipe(v.array(v.string()), v.minLength(1)),
  }),
]);
const recentWriteSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("Comment"),
    commentId: v.string(),
    reviewId: v.optional(v.string()),
  }),
  v.strictObject({
    _tag: v.literal("ThreadState"),
    threadId: v.string(),
    state: v.picklist(["open", "resolved"]),
  }),
  v.strictObject({
    _tag: v.literal("LabelChange"),
    added: v.array(v.string()),
    removed: v.array(v.string()),
  }),
  v.strictObject({
    _tag: v.literal("AssigneeChange"),
    added: v.array(v.string()),
    removed: v.array(v.string()),
  }),
  v.strictObject({
    _tag: v.literal("ReviewerChange"),
    requested: v.array(v.string()),
    removed: v.array(v.string()),
  }),
]);
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
      receipt: v.optional(recentWriteSchema),
    }),
  ]),
  startedAt: v.string(),
});

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
  if (state.receipt._tag === "Comment") {
    return {
      _tag: "Confirmed",
      receipt:
        state.receipt.reviewId === undefined
          ? { _tag: "Comment", commentId: state.receipt.commentId }
          : {
              _tag: "Comment",
              commentId: state.receipt.commentId,
              reviewId: state.receipt.reviewId,
            },
    };
  }
  if (state.receipt._tag === "ThreadState") {
    const threadId = parseGitHubThreadId(state.receipt.threadId);
    if (threadId._tag === "err") return undefined;
    return {
      _tag: "Confirmed",
      receipt: {
        _tag: "ThreadState",
        threadId: threadId.value,
        state: state.receipt.state,
      },
    };
  }
  return { _tag: "Confirmed", receipt: state.receipt };
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
