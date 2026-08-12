import { describe, expect, it } from "vitest";

import {
  adoptObservedPendingReview,
  beginPendingReviewWrite,
  canStartPendingReviewOperation,
  confirmPendingReviewWrite,
  markPendingReviewOutcomeUnknown,
  parseFindingReviewReceipts,
  parsePendingReviewState,
  parseViewerPendingReview,
  pendingReviewMatchesSession,
  reconcilePendingReviewState,
  rejectPendingReviewWrite,
  type PendingReviewOperation,
  type PendingReviewState,
  type ViewerPendingReview,
} from "../../src/domain/pending-review";

const reviewRaw = {
  restId: "4891263665",
  nodeId: "PRR_kwDORJzsQM7e6QwJ",
  author: "pmquan2cfw",
  pr: {
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    number: 80,
  },
  headSha: "3cc09e865fedf015cd86263594e094d94c006916",
  comments: [
    {
      reviewCommentId: "PRRC_kwDORJzsQM7fI2Rd",
      threadId: "PRRT_kwDORJzsQM0001",
      body: "Comment body",
      anchor: {
        path: "docs/docs.go",
        startLine: 2908,
        line: 2908,
        side: "new",
      },
      createdAt: "2026-08-09T11:34:50.000Z",
    },
  ],
  createdAt: "2026-08-09T11:34:50.000Z",
  updatedAt: "2026-08-09T11:34:50.000Z",
};

const startOperation: PendingReviewOperation = {
  _tag: "Start",
  requestId: "pending-review-start-1" as never,
};
const addThreadOperation: PendingReviewOperation = {
  _tag: "AddThread",
  requestId: "pending-review-add-1" as never,
  reviewId: "PRR_kwDORJzsQM7e6QwJ" as never,
  anchor: {
    path: "docs/docs.go" as never,
    startLine: 2908,
    line: 2908,
    side: "new",
  },
};
const submitOperation: PendingReviewOperation = {
  _tag: "Submit",
  requestId: "pending-review-submit-1" as never,
  reviewId: "4891263665" as never,
  event: "COMMENT",
};
const discardOperation: PendingReviewOperation = {
  _tag: "Discard",
  requestId: "pending-review-discard-1" as never,
  reviewId: "4891263665" as never,
};

function review(): ViewerPendingReview {
  const parsed = parseViewerPendingReview(reviewRaw);
  if (parsed._tag === "err") throw new Error("fixture");
  return parsed.value;
}

describe("parsePendingReviewState", () => {
  it("round-trips None, Pending, WriteInFlight, and OutcomeUnknown", () => {
    for (const state of [
      { _tag: "None" as const },
      { _tag: "Pending" as const, review: review() },
      {
        _tag: "WriteInFlight" as const,
        review: review(),
        operation: addThreadOperation,
        startedAt: "2026-08-09T11:35:00.000Z",
      },
      {
        _tag: "OutcomeUnknown" as const,
        operation: submitOperation,
        startedAt: "2026-08-09T11:35:00.000Z",
      },
      {
        _tag: "OutcomeUnknown" as const,
        operation: discardOperation,
        startedAt: "2026-08-09T11:35:00.000Z",
      },
    ]) {
      const parsed = parsePendingReviewState(state);
      expect(parsed._tag, state._tag).toBe("ok");
      if (parsed._tag === "ok") expect(parsed.value).toEqual(state);
    }
  });

  it("rejects malformed identities, timestamps, and anchors", () => {
    expect(
      parsePendingReviewState({ _tag: "None", extra: true } as never)._tag,
    ).toBe("err");
    expect(
      parsePendingReviewState({
        _tag: "Pending",
        review: { ...reviewRaw, restId: "not-a-number" },
      })._tag,
    ).toBe("err");
    expect(
      parsePendingReviewState({
        _tag: "Pending",
        review: { ...reviewRaw, nodeId: "bad node id" },
      })._tag,
    ).toBe("err");
    expect(
      parsePendingReviewState({
        _tag: "Pending",
        review: {
          ...reviewRaw,
          comments: [
            {
              ...reviewRaw.comments[0],
              anchor: {
                path: "docs/docs.go",
                startLine: 9,
                line: 8,
                side: "new",
              },
            },
          ],
        },
      })._tag,
    ).toBe("err");
    expect(
      parsePendingReviewState({
        _tag: "WriteInFlight",
        operation: { ...startOperation, requestId: "not-a-request" },
        startedAt: "2026-08-09T11:35:00.000Z",
      })._tag,
    ).toBe("err");
    expect(
      parsePendingReviewState({
        _tag: "OutcomeUnknown",
        operation: submitOperation,
        startedAt: "not-a-timestamp",
      })._tag,
    ).toBe("err");
  });

  it("rejects duplicate thread identities within one review", () => {
    const duplicate = {
      ...reviewRaw,
      comments: [reviewRaw.comments[0], reviewRaw.comments[0]],
    };
    expect(
      parsePendingReviewState({ _tag: "Pending", review: duplicate })._tag,
    ).toBe("err");
  });

  it("rejects a confirmed review that does not match the represented PR", () => {
    const foreign = {
      ...reviewRaw,
      pr: {
        host: "github.com",
        owner: "other-org",
        repo: "other-repo",
        number: 1,
      },
    };
    const parsed = parsePendingReviewState({
      _tag: "Pending",
      review: foreign,
    });
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "ok") {
      expect(
        pendingReviewMatchesSession(parsed.value, {
          host: "github.com" as never,
          owner: "centraldigital" as never,
          repo: "patchdesk" as never,
          number: 80 as never,
        }),
      ).toBe(false);
    }
  });
});

describe("pending-review state transitions", () => {
  it("Start is legal only from None; AddThread/Submit/Discard only from the matching Pending review", () => {
    expect(
      canStartPendingReviewOperation({ _tag: "None" }, startOperation),
    ).toBe(true);
    expect(
      canStartPendingReviewOperation(
        { _tag: "Pending", review: review() },
        startOperation,
      ),
    ).toBe(false);
    const pending = { _tag: "Pending" as const, review: review() };
    expect(canStartPendingReviewOperation(pending, addThreadOperation)).toBe(
      true,
    );
    expect(canStartPendingReviewOperation(pending, submitOperation)).toBe(true);
    expect(canStartPendingReviewOperation(pending, discardOperation)).toBe(
      true,
    );
    expect(
      canStartPendingReviewOperation(pending, {
        ...addThreadOperation,
        reviewId: "PRR_other000000000" as never,
      }),
    ).toBe(false);
    expect(
      canStartPendingReviewOperation({ _tag: "None" }, submitOperation),
    ).toBe(false);
    expect(
      canStartPendingReviewOperation({ _tag: "None" }, discardOperation),
    ).toBe(false);
  });

  it("locked states reject every new operation", () => {
    const locked: PendingReviewState = {
      _tag: "OutcomeUnknown",
      operation: submitOperation,
      startedAt: "2026-08-09T11:35:00.000Z" as never,
    };
    expect(canStartPendingReviewOperation(locked, startOperation)).toBe(false);
    expect(canStartPendingReviewOperation(locked, addThreadOperation)).toBe(
      false,
    );
  });

  it("begin -> confirm persists the receipt state", () => {
    const begun = beginPendingReviewWrite(
      { _tag: "None" },
      startOperation,
      "2026-08-09T11:35:00.000Z" as never,
    );
    expect(begun).toMatchObject({
      _tag: "ok",
      value: { _tag: "WriteInFlight", operation: startOperation },
    });
    if (begun._tag !== "ok") return;
    const confirmed = confirmPendingReviewWrite(begun.value, review());
    expect(confirmed).toMatchObject({
      _tag: "ok",
      value: { _tag: "Pending", review: { restId: "4891263665" } },
    });
  });

  it("confirm with no review records None (submitted pending review)", () => {
    const begun = beginPendingReviewWrite(
      { _tag: "Pending", review: review() },
      submitOperation,
      "2026-08-09T11:35:00.000Z" as never,
    );
    if (begun._tag !== "ok") throw new Error("fixture");
    const confirmed = confirmPendingReviewWrite(begun.value, undefined);
    expect(confirmed).toMatchObject({ _tag: "ok", value: { _tag: "None" } });
  });

  it("rejection restores the last confirmed remote state", () => {
    const begun = beginPendingReviewWrite(
      { _tag: "Pending", review: review() },
      addThreadOperation,
      "2026-08-09T11:35:00.000Z" as never,
    );
    if (begun._tag !== "ok") throw new Error("fixture");
    const rejected = rejectPendingReviewWrite(begun.value);
    expect(rejected).toMatchObject({
      _tag: "ok",
      value: { _tag: "Pending", review: { restId: "4891263665" } },
    });
  });

  it("timeout or lost response becomes OutcomeUnknown with the same operation", () => {
    const begun = beginPendingReviewWrite(
      { _tag: "None" },
      startOperation,
      "2026-08-09T11:35:00.000Z" as never,
    );
    if (begun._tag !== "ok") throw new Error("fixture");
    const unknown = markPendingReviewOutcomeUnknown(begun.value);
    expect(unknown).toMatchObject({
      _tag: "ok",
      value: { _tag: "OutcomeUnknown", operation: startOperation },
    });
  });
});

describe("unresolved Finding ownership", () => {
  it("round-trips a proven pending owner with one unresolved Finding", () => {
    const unresolvedFinding = {
      analysisRunId: "insight-analysis-1-aaaaaaaaaaaa-fixture" as never,
      findingId: "finding-1" as never,
      sessionId:
        "github.com__centraldigital__patchdesk__pr-80__sha-3cc09e86__0123456789ab" as never,
      headSha: reviewRaw.headSha as never,
      patchHash: "a".repeat(64) as never,
    };
    expect(
      parsePendingReviewState({
        _tag: "Pending",
        review: reviewRaw,
        unresolvedFinding,
      }),
    ).toMatchObject({
      _tag: "ok",
      value: {
        _tag: "Pending",
        unresolvedFinding: { findingId: "finding-1" },
      },
    });
  });
});

describe("reconcilePendingReviewState", () => {
  const locked = (operation: PendingReviewOperation): PendingReviewState => ({
    _tag: "OutcomeUnknown",
    operation,
    startedAt: "2026-08-09T11:35:00.000Z" as never,
  });

  it("maps a proven Start result and leaves Unavailable locked", () => {
    expect(
      reconcilePendingReviewState(locked(startOperation), {
        _tag: "Pending",
        review: review(),
      }),
    ).toMatchObject({
      _tag: "Pending",
      review: { restId: "4891263665" },
    });
    expect(
      reconcilePendingReviewState(locked(startOperation), { _tag: "None" }),
    ).toEqual({ _tag: "None" });
    const stillLocked = reconcilePendingReviewState(locked(startOperation), {
      _tag: "Unavailable",
    });
    expect(stillLocked).toMatchObject({
      _tag: "OutcomeUnknown",
      operation: startOperation,
    });
  });

  it("exposes the proven owner while keeping an ambiguous Finding unresolved", () => {
    const findingStart: PendingReviewOperation = {
      ...startOperation,
      finding: {
        analysisRunId: "insight-analysis-1-aaaaaaaaaaaa-fixture" as never,
        findingId: "finding-1" as never,
        sessionId: "session-a" as never,
        headSha: "1".repeat(40) as never,
        patchHash: "a".repeat(64) as never,
      },
    };
    expect(
      reconcilePendingReviewState(locked(findingStart), { _tag: "None" }),
    ).toEqual({ _tag: "None" });
    expect(
      reconcilePendingReviewState(locked(findingStart), {
        _tag: "Pending",
        review: review(),
      }),
    ).toMatchObject({
      _tag: "Pending",
      review: { restId: "4891263665" },
      unresolvedFinding: { findingId: "finding-1" },
    });
  });

  it("maps Discard: not executed stays Pending; complete absence resolves to None", () => {
    expect(
      reconcilePendingReviewState(locked(discardOperation), {
        _tag: "Pending",
        review: review(),
      }),
    ).toMatchObject({
      _tag: "Pending",
    });
    expect(
      reconcilePendingReviewState(locked(discardOperation), { _tag: "None" }),
    ).toEqual({ _tag: "None" });
    const stillLocked = reconcilePendingReviewState(locked(discardOperation), {
      _tag: "Unavailable",
    });
    expect(stillLocked).toMatchObject({
      _tag: "OutcomeUnknown",
      operation: discardOperation,
    });
  });

  it("maps Submit that did not execute back to Pending; ambiguous absence stays locked", () => {
    expect(
      reconcilePendingReviewState(locked(submitOperation), {
        _tag: "Pending",
        review: review(),
      }),
    ).toMatchObject({
      _tag: "Pending",
    });
    expect(
      reconcilePendingReviewState(locked(submitOperation), { _tag: "None" }),
    ).toMatchObject({
      _tag: "OutcomeUnknown",
    });
  });

  it("maps AddThread only when a newer comment proves the thread landed", () => {
    const newerReview = {
      ...reviewRaw,
      comments: [
        ...reviewRaw.comments,
        {
          reviewCommentId: "PRRC_kwDORJzsQM7fI2Xp",
          threadId: "PRRT_kwDORJzsQM0002",
          body: "Newer",
          anchor: {
            path: "docs/docs.go",
            startLine: 2912,
            line: 2912,
            side: "new",
          },
          createdAt: "2026-08-09T11:36:00.000Z",
        },
      ],
      updatedAt: "2026-08-09T11:36:00.000Z",
    };
    const parsed = parseViewerPendingReview(newerReview);
    if (parsed._tag !== "ok") throw new Error("fixture");
    expect(
      reconcilePendingReviewState(locked(addThreadOperation), {
        _tag: "Pending",
        review: parsed.value,
      }),
    ).toMatchObject({ _tag: "Pending", review: { restId: "4891263665" } });
    // No comment newer than the write start: the thread did not land.
    const stale = reconcilePendingReviewState(locked(addThreadOperation), {
      _tag: "Pending",
      review: review(),
    });
    expect(stale).toMatchObject({ _tag: "OutcomeUnknown" });
  });

  it("never reconciles a confirmed state", () => {
    const confirmed: PendingReviewState = { _tag: "Pending", review: review() };
    expect(reconcilePendingReviewState(confirmed, { _tag: "None" })).toBe(
      confirmed,
    );
  });
});

describe("adoptObservedPendingReview", () => {
  it("adopts a confirmed remote owner but preserves write recovery ownership", () => {
    expect(
      adoptObservedPendingReview(
        { _tag: "None" },
        { _tag: "Pending", review: review() },
      ),
    ).toEqual({ _tag: "Pending", review: review() });
    const locked: PendingReviewState = {
      _tag: "OutcomeUnknown",
      review: review(),
      operation: addThreadOperation,
      startedAt: "2026-08-09T11:35:00.000Z" as never,
    };
    expect(adoptObservedPendingReview(locked, { _tag: "None" })).toEqual(
      locked,
    );
  });
});

describe("parseFindingReviewReceipts", () => {
  it("keeps pending receipts valid while their owner has a locked operation", () => {
    const owner = review();
    const threadId = owner.comments[0]?.threadId;
    if (threadId === undefined) throw new Error("fixture");
    const sessionId =
      "github.com__centraldigital__patchdesk__pr-80__sha-3cc09e86__0123456789ab" as never;
    const receipt = {
      analysisRunId: "insight-analysis-1-aaaaaaaaaaaa-fixture",
      findingId: "finding-1",
      sessionId,
      headSha: reviewRaw.headSha,
      patchHash: "a".repeat(64),
      threadId,
      pendingReviewNodeId: reviewRaw.nodeId,
      state: "pending",
    };
    for (const _tag of ["WriteInFlight", "OutcomeUnknown"] as const) {
      expect(
        parseFindingReviewReceipts([receipt], {
          id: sessionId,
          headSha: reviewRaw.headSha as never,
          pendingReview: {
            _tag,
            review: owner,
            operation: {
              _tag: "Discard",
              requestId: "pending-review-discard-1" as never,
              reviewId: owner.restId,
            },
            startedAt: "2026-08-09T11:35:00.000Z" as never,
          },
        }),
      ).toMatchObject({ _tag: "ok" });
    }
  });

  it("accepts the receipt fields in addition to the strict Finding identity", () => {
    const pendingReview = {
      _tag: "Pending" as const,
      review: review(),
    };
    const threadId = pendingReview.review.comments[0]?.threadId;
    if (threadId === undefined) throw new Error("fixture");
    expect(
      parseFindingReviewReceipts(
        [
          {
            analysisRunId: "insight-analysis-1-aaaaaaaaaaaa-fixture",
            findingId: "finding-1",
            sessionId:
              "github.com__centraldigital__patchdesk__pr-80__sha-3cc09e86__0123456789ab",
            headSha: reviewRaw.headSha,
            patchHash: "a".repeat(64),
            threadId,
            pendingReviewNodeId: reviewRaw.nodeId,
            state: "pending",
          },
        ],
        {
          id: "github.com__centraldigital__patchdesk__pr-80__sha-3cc09e86__0123456789ab" as never,
          headSha: reviewRaw.headSha as never,
          pendingReview,
        },
      ),
    ).toMatchObject({
      _tag: "ok",
      value: [{ threadId, state: "pending" }],
    });
  });
});
