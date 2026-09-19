import { describe, expect, it } from "vitest";

import { parseGitHubThreadId } from "../../src/domain/ids";
import type { RecentReviewWrite } from "../../src/domain/recent-review-write";
import {
  confirmReviewWrite,
  markReviewWriteOutcomeUnknown,
  parseReviewWriteOperation,
  setReviewWriteResolution,
} from "../../src/domain/review-write-operation";
import {
  reviewWriteIntents,
  storedReviewWriteOperation as stored,
} from "./review-write-operation-fixture";

describe("review write operation", () => {
  it("parses a valid persisted operation and applies legal recovery transitions", () => {
    const parsed = parseReviewWriteOperation(stored);
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "err") return;
    const unknown = markReviewWriteOutcomeUnknown(parsed.value);
    expect(unknown._tag).toBe("ok");
    if (unknown._tag === "err") return;
    expect(unknown.value.state).toEqual({
      _tag: "OutcomeUnknown",
      resolution: "check_required",
    });
    const confirmed = confirmReviewWrite(unknown.value, {
      _tag: "Comment",
      commentId: "PRRC_reply",
    });
    expect(confirmed._tag).toBe("ok");
    if (confirmed._tag === "err") return;
    expect(confirmed.value.state).toEqual({
      _tag: "Confirmed",
      receipt: { _tag: "Comment", commentId: "PRRC_reply" },
    });
  });

  it("rejects illegal state transitions", () => {
    const parsed = parseReviewWriteOperation(stored);
    if (parsed._tag === "err") throw new Error("invalid fixture");
    expect(confirmReviewWrite(parsed.value)).toEqual({
      _tag: "err",
      error: { _tag: "InvalidReviewWriteOperation" },
    });
    expect(
      setReviewWriteResolution(parsed.value, "manual_resolution_required"),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidReviewWriteOperation" },
    });
    const unknown = markReviewWriteOutcomeUnknown(parsed.value);
    if (unknown._tag === "err") throw new Error("invalid fixture");
    expect(markReviewWriteOutcomeUnknown(unknown.value)).toEqual({
      _tag: "err",
      error: { _tag: "InvalidReviewWriteOperation" },
    });
    const confirmed = confirmReviewWrite(unknown.value);
    if (confirmed._tag === "err") throw new Error("invalid fixture");
    expect(confirmReviewWrite(confirmed.value)).toEqual({
      _tag: "err",
      error: { _tag: "InvalidReviewWriteOperation" },
    });
  });

  it("fails closed when persisted session identity disagrees with the intent", () => {
    expect(
      parseReviewWriteOperation({
        ...stored,
        sessionId:
          "github.com__octo-org__patchdesk__pr-42__sha-33333333__base-22222222__abcdef123456",
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidReviewWriteOperation" },
    });
  });

  it("rejects malformed stored variants", () => {
    expect(
      parseReviewWriteOperation({ ...stored, state: { _tag: "RetrySafe" } }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidReviewWriteOperation" },
    });
  });
  it("rejects unparsed persisted actor and thread identifiers", () => {
    expect(
      parseReviewWriteOperation({
        ...stored,
        intent: { ...stored.intent, actor: "not a login", threadId: "thread" },
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidReviewWriteOperation" },
    });
  });
});

it.each(Object.entries(reviewWriteIntents))(
  "round-trips a persisted %s intent",
  (_tag, intent) => {
    const parsed = parseReviewWriteOperation({ ...stored, intent });
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "ok") expect(parsed.value.intent).toEqual(intent);
  },
);

it("rejects a persisted dismissal that uses a GraphQL node id instead of the REST review id", () => {
  expect(
    parseReviewWriteOperation({
      ...stored,
      intent: {
        _tag: "DismissPublishedReview",
        expected: stored.intent.expected,
        publishedReviewId: "PRR_node",
        message: "stale approval",
      },
    }),
  ).toEqual({
    _tag: "err",
    error: { _tag: "InvalidReviewWriteOperation" },
  });
});

const receiptThreadId = parseGitHubThreadId("PRRT_thread");
if (receiptThreadId._tag === "err") throw new Error("invalid fixture");
const confirmedReceipts = {
  Comment: { _tag: "Comment", commentId: "PRRC_1", reviewId: "PRR_1" },
  ThreadState: {
    _tag: "ThreadState",
    threadId: receiptThreadId.value,
    state: "resolved",
  },
  PendingThread: { _tag: "PendingThread", threadId: receiptThreadId.value },
  DiscardedThread: { _tag: "DiscardedThread", threadId: receiptThreadId.value },
  DeletedComment: {
    _tag: "DeletedComment",
    commentId: "2145998877",
    nodeId: "PRRC_deleted",
  },
  DirectSummaryReview: { _tag: "DirectSummaryReview", reviewId: "PRR_1" },
  LabelChange: { _tag: "LabelChange", added: ["bug"], removed: [] },
  AssigneeChange: { _tag: "AssigneeChange", added: ["octocat"], removed: [] },
  ReviewerChange: {
    _tag: "ReviewerChange",
    requested: ["octocat"],
    removed: ["hubot"],
  },
  DraftStateChange: { _tag: "DraftStateChange", draft: true },
  BaseBranchChange: { _tag: "BaseBranchChange", branch: "release/1.2" },
} satisfies Record<RecentReviewWrite["_tag"], RecentReviewWrite>;

it.each(Object.entries(confirmedReceipts))(
  "round-trips a Confirmed %s receipt",
  (_tag, receipt) => {
    const state = { _tag: "Confirmed", receipt };
    const parsed = parseReviewWriteOperation({ ...stored, state });
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "ok") expect(parsed.value.state).toEqual(state);
  },
);
