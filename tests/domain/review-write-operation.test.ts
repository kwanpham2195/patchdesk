import { describe, expect, it } from "vitest";

import {
  confirmReviewWrite,
  markReviewWriteOutcomeUnknown,
  parseReviewWriteOperation,
  setReviewWriteResolution,
} from "../../src/domain/review-write-operation";

const stored = {
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
          "github.com__centraldigital__patchdesk__pr-42__sha-33333333__base-22222222__abcdef123456",
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

it.each([
  ["AddLabels", "names", ["bug"]],
  ["RemoveLabels", "names", ["bug"]],
  ["AddAssignees", "logins", ["OctoCat"]],
  ["RemoveAssignees", "logins", ["OctoCat"]],
  ["RequestReviewers", "logins", ["hubot"]],
  ["RemoveReviewers", "logins", ["hubot"]],
] as const)(
  "parses PR-level %s intent without revision evidence",
  (tag, field, values) => {
    const parsed = parseReviewWriteOperation({
      ...stored,
      intent: { _tag: tag, [field]: values },
    });
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "ok")
      expect(parsed.value.intent).toEqual({ _tag: tag, [field]: values });
  },
);

it.each([
  ["EditPublishedComment", { commentId: "201", body: "edited" }],
  ["DeletePublishedComment", { commentId: "201" }],
  [
    "DismissPublishedReview",
    { publishedReviewId: "101", message: "stale approval" },
  ],
] as const)("parses revision-bound %s intent", (tag, evidence) => {
  const parsed = parseReviewWriteOperation({
    ...stored,
    intent: { _tag: tag, expected: stored.intent.expected, ...evidence },
  });
  expect(parsed._tag).toBe("ok");
  if (parsed._tag === "ok")
    expect(parsed.value.intent).toEqual({
      _tag: tag,
      expected: stored.intent.expected,
      ...evidence,
    });
});

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
