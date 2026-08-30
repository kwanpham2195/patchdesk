import { describe, expect, it, vi } from "vitest";

import type { ReviewWriteOperation } from "../../src/domain/review-write-operation";
import { err, ok } from "../../src/domain/result";
import { PublishedFeedbackService } from "../../src/services/published-feedback-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

// SAFETY: literals model already-validated revision evidence; this test owns write ordering, not parser coverage.
const expected = {
  sessionId:
    "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456" as never,
  headSha: "a".repeat(40) as never,
  patchHash: "b".repeat(64) as never,
};
// SAFETY: literals model already-validated route identifiers; parser coverage belongs to the route suite.
const input = {
  profileId: "cfw" as never,
  reviewId:
    "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456" as never,
  expected,
};
// SAFETY: requireFresh returns this fixture unchanged; no profile fields are read by this service test.
const profile = { ghAccount: "reviewer", githubHost: "github.com" } as never;
// SAFETY: this minimal session supplies the key fields PublishedFeedbackService reads after gate admission.
const session = {
  id: expected.sessionId,
  key: {
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    prNumber: 42,
    headSha: expected.headSha,
  },
} as never;
// SAFETY: timestamps are opaque branded values here; feedback behavior is asserted through the supplied records.
const feedback = {
  reviews: [
    {
      id: "101",
      author: "reviewer",
      body: "",
      event: "APPROVED" as const,
      submittedAt: "2026-08-01T00:00:00.000Z" as never,
      canDismiss: true,
    },
  ],
  comments: [
    {
      id: "201",
      author: "reviewer",
      body: "old",
      createdAt: "2026-08-01T00:00:00.000Z" as never,
      canEdit: true,
      canDelete: true,
    },
  ],
  complete: true,
};
const unavailable = {
  _tag: "GitHubWriteFailure" as const,
  category: "unavailable" as const,
  message: "unavailable",
};

function fixture(
  options: {
    readonly write?: () => Promise<
      ReturnType<typeof ok<void>> | ReturnType<typeof err<typeof unavailable>>
    >;
    readonly refresh?: () => Promise<
      ReturnType<typeof ok<void>> | ReturnType<typeof err<string>>
    >;
    readonly headSha?: string;
    readonly publishedFeedback?: typeof feedback;
  } = {},
) {
  const trace: string[] = [];
  let operation: ReviewWriteOperation | undefined;
  const append = vi.fn(async () => {
    trace.push("journal");
    return ok(undefined);
  });
  const writer = vi.fn(async () => {
    trace.push("write");
    return options.write === undefined ? ok(undefined) : options.write();
  });
  const operations = {
    load: vi.fn(async () => ok(operation)),
    begin: vi.fn(async (next: ReviewWriteOperation) => {
      operation = next;
      trace.push(`intent:${next.state._tag}`);
      return ok(undefined);
    }),
    markOutcomeUnknown: vi.fn(async (next: ReviewWriteOperation) => {
      operation = next;
      trace.push(`intent:${next.state._tag}`);
      return ok(undefined);
    }),
    confirm: vi.fn(async (next: ReviewWriteOperation) => {
      operation = next;
      trace.push(`intent:${next.state._tag}`);
      return ok(undefined);
    }),
    reject: vi.fn(async () => {
      operation = undefined;
      trace.push("reject");
      return ok(undefined);
    }),
    remove: vi.fn(async () => {
      operation = undefined;
      trace.push("remove");
      return ok(undefined);
    }),
  };
  // SAFETY: the fixture supplies only dependencies this suite observes; omitted gate snapshot and review fields are never read.
  const service = new PublishedFeedbackService(
    {
      requireFresh: async () =>
        ok({ profile, review: {} as never, session, snapshot: {} as never }),
    },
    {
      async getPullRequest() {
        trace.push("head");
        // SAFETY: this gateway read exposes only the branded head SHA consumed by requireCurrentHead.
        return ok({
          headSha: (options.headSha ?? expected.headSha) as never,
        } as never);
      },
      async getPullRequestPublishedFeedback() {
        trace.push("authorization");
        return ok(options.publishedFeedback ?? feedback);
      },
      updateReviewComment: writer,
      deleteReviewComment: writer,
      dismissReview: writer,
    },
    new ReviewOperationCoordinator(),
    () => "2026-08-01T00:00:00.000Z" as never,
    { append },
    operations,
    options.refresh,
  );
  return {
    service,
    trace,
    writer,
    append,
    operations,
    operation: () => operation,
  };
}

describe("PublishedFeedbackService", () => {
  it.each([
    [
      "edit",
      () =>
        fixture().service.editComment({
          ...input,
          commentId: "201",
          body: " ",
        }),
    ],
    [
      "delete",
      () =>
        fixture().service.deleteComment({
          ...input,
          commentId: "201",
          confirmation: false,
        }),
    ],
    [
      "dismiss",
      () =>
        fixture().service.dismissReview({
          ...input,
          publishedReviewId: "not-rest-id",
          message: "reason",
          confirmation: true,
        }),
    ],
  ])(
    "rejects deterministic %s validation before durable admission",
    async (_name, issue) => {
      const result = await issue();
      expect(result._tag).toBe("err");
    },
  );

  it("runs authorization and current-head checks before persisting exact edit intent", async () => {
    const built = fixture();
    await expect(
      built.service.editComment({
        ...input,
        commentId: "201",
        body: " edited\r\n",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        _tag: "PublishedCommentEdited",
        commentId: "201",
        reconciliation: "complete",
      },
    });
    expect(built.trace).toEqual([
      "authorization",
      "head",
      "intent:Requested",
      "intent:OutcomeUnknown",
      "write",
      "intent:Confirmed",
      "journal",
      "remove",
    ]);
    expect(built.operations.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          _tag: "EditPublishedComment",
          expected,
          commentId: "201",
          body: "edited",
        },
      }),
    );
  });

  it.each([
    [
      "delete",
      (service: PublishedFeedbackService) =>
        service.deleteComment({
          ...input,
          commentId: "201",
          confirmation: true,
        }),
      "DeletePublishedComment",
      "PublishedCommentDeleted",
    ],
    [
      "dismiss",
      (service: PublishedFeedbackService) =>
        service.dismissReview({
          ...input,
          publishedReviewId: "101",
          message: " stale ",
          confirmation: true,
        }),
      "DismissPublishedReview",
      "PublishedReviewDismissed",
    ],
  ] as const)(
    "confirms %s without fabricating a comment-existence journal",
    async (_name, issue, intentTag, receiptTag) => {
      const built = fixture();
      const result = await issue(built.service);
      expect(result).toMatchObject({ _tag: "ok", value: { _tag: receiptTag } });
      expect(built.operations.begin).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({ _tag: intentTag }),
        }),
      );
      expect(built.append).not.toHaveBeenCalled();
      expect(built.trace.slice(-2)).toEqual(["intent:Confirmed", "remove"]);
    },
  );

  it("retains an unavailable or thrown write as outcome-unknown and refuses a second write", async () => {
    for (const write of [
      async () => err(unavailable),
      async () => {
        throw new Error("lost response");
      },
    ]) {
      const built = fixture({ write });
      const command = { ...input, commentId: "201", confirmation: true };
      await expect(built.service.deleteComment(command)).resolves.toEqual({
        _tag: "err",
        error: "outcome_unknown",
      });
      await expect(built.service.deleteComment(command)).resolves.toEqual({
        _tag: "err",
        error: "outcome_unknown",
      });
      expect(built.writer).toHaveBeenCalledOnce();
      expect(built.operation()?.state._tag).toBe("OutcomeUnknown");
    }
  });

  it("rejects and removes deterministic writer failure so a corrected command may retry", async () => {
    const rejected = {
      _tag: "GitHubWriteFailure" as const,
      category: "rejected" as const,
      message: "rejected",
    };
    // SAFETY: the fixture write union intentionally permits both deterministic and unavailable GitHub failure categories.
    const built = fixture({ write: async () => err(rejected as never) });
    const command = { ...input, commentId: "201", confirmation: true };
    await expect(built.service.deleteComment(command)).resolves.toEqual({
      _tag: "err",
      error: "github_write_failed",
    });
    await built.service.deleteComment(command);
    expect(built.writer).toHaveBeenCalledTimes(2);
    expect(built.operations.reject).toHaveBeenCalledTimes(2);
  });

  it("returns confirmed success with reconciliation required when refresh fails", async () => {
    const built = fixture({ refresh: async () => err("refresh failed") });
    await expect(
      built.service.deleteComment({
        ...input,
        commentId: "201",
        confirmation: true,
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        _tag: "PublishedCommentDeleted",
        commentId: "201",
        reconciliation: "required",
      },
    });
    expect(built.operation()).toBeUndefined();
  });

  it("refuses a head race before durable admission or GitHub write", async () => {
    const built = fixture({ headSha: "c".repeat(40) });
    await expect(
      built.service.editComment({ ...input, commentId: "201", body: "new" }),
    ).resolves.toEqual({ _tag: "err", error: "not_fresh" });
    expect(built.operations.begin).not.toHaveBeenCalled();
    expect(built.writer).not.toHaveBeenCalled();
  });
});
