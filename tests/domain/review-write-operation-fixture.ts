import {
  parseContentHash,
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  parseGitSha,
  parseRepoRelativePath,
  parseReviewSessionId,
} from "../../src/domain/ids";
import type { ReviewWriteIntent } from "../../src/domain/review-write-operation";
import type { Result } from "../../src/domain/result";

/** A persisted Reply operation in its on-disk JSON shape. */
export const storedReviewWriteOperation = {
  schemaVersion: 1,
  profileId: "cfw",
  reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
  sessionId:
    "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
  intent: {
    _tag: "Reply",
    expected: {
      sessionId:
        "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
      headSha: "1".repeat(40),
      patchHash: "a".repeat(64),
    },
    actor: "reviewer",
    threadId: "PRRT_thread",
    body: "reply",
  },
  state: { _tag: "Requested" },
  startedAt: "2026-01-01T00:00:00.000Z",
};

function fixtureValue<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}

const expected = {
  sessionId: fixtureValue(
    parseReviewSessionId(storedReviewWriteOperation.intent.expected.sessionId),
  ),
  headSha: fixtureValue(
    parseGitSha(storedReviewWriteOperation.intent.expected.headSha),
  ),
  patchHash: fixtureValue(
    parseContentHash(storedReviewWriteOperation.intent.expected.patchHash),
  ),
};
const actor = fixtureValue(parseGitHubLogin("reviewer"));
const threadId = fixtureValue(parseGitHubThreadId("PRRT_thread"));
const commentId = fixtureValue(parseGitHubReviewCommentId("PRRC_comment"));

/** One intent per tag, bound to `storedReviewWriteOperation`'s session; a new tag fails to compile here. */
export const reviewWriteIntents = {
  CreateComment: {
    _tag: "CreateComment",
    expected,
    actor,
    anchor: {
      path: fixtureValue(parseRepoRelativePath("src/app.ts")),
      startLine: 3,
      line: 5,
      side: "new",
    },
    body: "comment",
  },
  Reply: { _tag: "Reply", expected, actor, threadId, body: "reply" },
  SetThreadState: {
    _tag: "SetThreadState",
    expected,
    threadId,
    state: "resolved",
  },
  EditComment: { _tag: "EditComment", expected, commentId, body: "edited" },
  DeleteComment: { _tag: "DeleteComment", expected, commentId },
  EditPublishedComment: {
    _tag: "EditPublishedComment",
    expected,
    commentId: fixtureValue(parseGitHubReviewCommentId("201")),
    body: "edited",
  },
  DeletePublishedComment: {
    _tag: "DeletePublishedComment",
    expected,
    commentId: fixtureValue(parseGitHubReviewCommentId("201")),
  },
  DismissPublishedReview: {
    _tag: "DismissPublishedReview",
    expected,
    publishedReviewId: fixtureValue(parseGitHubReviewRestId("101")),
    message: "stale approval",
  },
  AddLabels: { _tag: "AddLabels", names: ["bug"] },
  RemoveLabels: { _tag: "RemoveLabels", names: ["bug"] },
  AddAssignees: { _tag: "AddAssignees", logins: ["OctoCat"] },
  RemoveAssignees: { _tag: "RemoveAssignees", logins: ["OctoCat"] },
  RequestReviewers: { _tag: "RequestReviewers", logins: ["hubot"] },
  RemoveReviewers: { _tag: "RemoveReviewers", logins: ["hubot"] },
  SetDraftState: { _tag: "SetDraftState", draft: true },
} satisfies Record<ReviewWriteIntent["_tag"], ReviewWriteIntent>;
