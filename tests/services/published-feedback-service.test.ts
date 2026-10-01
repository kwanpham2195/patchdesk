import { describe, expect, it, vi } from "vitest";

import type { GitHubReviewWriter } from "../../src/adapters/github/github-adapter";
import type { GitHubWriteFailure } from "../../src/domain/github-write";
import type { ReviewWriteOperation } from "../../src/domain/review-write-operation";
import { err, ok, type Result } from "../../src/domain/result";
import {
  GitHubRefusedPublishedFeedbackWrite,
  PublishedFeedbackService,
} from "../../src/services/published-feedback-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import type { ReviewRefreshFailure } from "../../src/services/review-refresh-service";

type UpdateReviewCommentInput = Parameters<
  NonNullable<GitHubReviewWriter["updateReviewComment"]>
>[0];
type DeleteReviewCommentInput = Parameters<
  NonNullable<GitHubReviewWriter["deleteReviewComment"]>
>[0];
type DismissReviewInput = Parameters<
  NonNullable<GitHubReviewWriter["dismissReview"]>
>[0];
type PublishedFeedbackWriteInput =
  | UpdateReviewCommentInput
  | DeleteReviewCommentInput
  | DismissReviewInput;

// SAFETY: literals model already-validated revision evidence; this test owns write ordering, not parser coverage.
const expected = {
  sessionId:
    "github.com__octo-org__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456" as never,
  headSha: "a".repeat(40) as never,
  patchHash: "b".repeat(64) as never,
};
// SAFETY: literals model already-validated route identifiers; parser coverage belongs to the route suite.
const input = {
  profileId: "acme" as never,
  reviewId: "acme__octo-org__patchdesk__pr-42__review-abcdef123456" as never,
  expected,
};
// SAFETY: requireFresh returns this fixture unchanged; no profile fields are read by this service test.
const profile = { ghAccount: "reviewer", githubHost: "github.com" } as never;
// SAFETY: this minimal session supplies the key fields PublishedFeedbackService reads after gate admission.
const session = {
  id: expected.sessionId,
  key: {
    host: "github.com",
    owner: "octo-org",
    repo: "patchdesk",
    source: { kind: "pull_request", prNumber: 42 },
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
      nodeId: "PRRC_201",
      author: "reviewer",
      body: "old",
      createdAt: "2026-08-01T00:00:00.000Z" as never,
      canEdit: true,
      canDelete: true,
    },
  ],
  issueComments: [],
  complete: true,
};
type FeedbackFixture = Omit<typeof feedback, "reviews"> & {
  readonly reviews: ReadonlyArray<
    Omit<(typeof feedback)["reviews"][number], "event"> & {
      readonly event: "APPROVED" | "DISMISSED";
    }
  >;
};
const unavailable = {
  _tag: "GitHubWriteFailure" as const,
  category: "unavailable" as const,
  message: "unavailable",
};

function fixture(
  options: {
    readonly write?: () => Promise<Result<void, GitHubWriteFailure>>;
    /** Successive published-feedback reads: the first is the pre-write authorization read, the next the landed check. The last answer repeats. */
    readonly feedbackReads?: ReadonlyArray<FeedbackFixture | "failure">;
    readonly refresh?: () => Promise<Result<undefined, ReviewRefreshFailure>>;
    readonly headSha?: string;
    readonly publishedFeedback?: typeof feedback;
  } = {},
) {
  const trace: string[] = [];
  let operation: ReviewWriteOperation | undefined;
  let readCount = 0;
  const appendConfirmed = vi.fn(async () => {
    trace.push("journal");
  });
  const writer = vi.fn(async (_input: PublishedFeedbackWriteInput) => {
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
  const gateway = {
    receiver: "published-feedback-gateway",
    async getPullRequest() {
      if (this.receiver !== "published-feedback-gateway")
        throw new Error("GitHub gateway receiver was lost");
      trace.push("head");
      // SAFETY: this gateway read exposes only the branded head SHA consumed by requireCurrentHead.
      return ok({
        headSha: (options.headSha ?? expected.headSha) as never,
      } as never);
    },
    async getPullRequestPublishedFeedback() {
      if (this.receiver !== "published-feedback-gateway")
        throw new Error("GitHub gateway receiver was lost");
      trace.push("authorization");
      const reads = options.feedbackReads;
      if (reads !== undefined) {
        const next = reads[Math.min(readCount, reads.length - 1)] ?? "failure";
        readCount += 1;
        // SAFETY: a failed read is modelled by an opaque error; the service only checks its tag.
        return next === "failure"
          ? err({ _tag: "GitHubReadFailed" } as never)
          : ok(next);
      }
      return ok(options.publishedFeedback ?? feedback);
    },
    async updateReviewComment(input: UpdateReviewCommentInput) {
      if (this.receiver !== "published-feedback-gateway")
        throw new Error("GitHub gateway receiver was lost");
      return writer(input);
    },
    async deleteReviewComment(input: DeleteReviewCommentInput) {
      if (this.receiver !== "published-feedback-gateway")
        throw new Error("GitHub gateway receiver was lost");
      return writer(input);
    },
    async dismissReview(input: DismissReviewInput) {
      if (this.receiver !== "published-feedback-gateway")
        throw new Error("GitHub gateway receiver was lost");
      return writer(input);
    },
  };
  // SAFETY: the fixture supplies only dependencies this suite observes; omitted gate snapshot and review fields are never read.
  const service = new PublishedFeedbackService(
    {
      requireFresh: async () =>
        ok({ profile, review: {} as never, session, snapshot: {} as never }),
    },
    gateway,
    new ReviewOperationCoordinator(),
    () => "2026-08-01T00:00:00.000Z" as never,
    { appendConfirmed },
    operations,
    options.refresh,
  );
  return {
    service,
    trace,
    writer,
    appendConfirmed,
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
    async (name, issue, intentTag, receiptTag) => {
      const built = fixture();
      const result = await issue(built.service);
      expect(result).toMatchObject({ _tag: "ok", value: { _tag: receiptTag } });
      expect(built.operations.begin).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({ _tag: intentTag }),
        }),
      );
      if (name === "delete") {
        // A `DeletedComment` receipt is proven by absence; journaling a
        // `Comment` here would gate every projection (#329, the #322 class).
        expect(built.appendConfirmed).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          { _tag: "DeletedComment", commentId: "201", nodeId: "PRRC_201" },
          expect.anything(),
        );
        expect(built.trace.slice(-3)).toEqual([
          "intent:Confirmed",
          "journal",
          "remove",
        ]);
      } else {
        expect(built.appendConfirmed).not.toHaveBeenCalled();
        expect(built.trace.slice(-2)).toEqual(["intent:Confirmed", "remove"]);
      }
    },
  );

  it("canonicalizes a GraphQL comment node id to the REST id before writing", async () => {
    const built = fixture();

    await expect(
      built.service.deleteComment({
        ...input,
        commentId: "PRRC_201",
        confirmation: true,
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        _tag: "PublishedCommentDeleted",
        commentId: "PRRC_201",
        reconciliation: "complete",
      },
    });
    expect(built.writer).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "201" }),
    );
    expect(built.operations.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ commentId: "201" }),
      }),
    );
  });

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

  describe("refused writes (issue #755)", () => {
    const refusal = (cause: "unprocessable" | "not_found" | "unsupported") =>
      err({
        _tag: "GitHubWriteFailure" as const,
        category: "refused" as const,
        message: "GitHub refused the request.",
        cause,
      });
    const refusedWith = (cause: string) => ({
      _tag: "err",
      error: { reason: "github_refused", cause },
    });
    const outcomeUnknown = { _tag: "err", error: "outcome_unknown" };
    const lockedState = {
      _tag: "OutcomeUnknown",
      resolution: "check_required",
    };
    const withReview = (event: "APPROVED" | "DISMISSED"): FeedbackFixture => ({
      ...feedback,
      reviews: feedback.reviews.map((review) => ({ ...review, event })),
    });
    const withoutComment = { ...feedback, comments: [] };
    // Another comment is still there: the landed check must match this comment's id, not any comment.
    const withOtherComment = {
      ...feedback,
      comments: feedback.comments.map((comment) => ({
        ...comment,
        id: "202",
        nodeId: "PRRC_202",
      })),
    };
    // Another review that is not dismissed: the check must match this review's id.
    const withOtherReview: FeedbackFixture = {
      ...feedback,
      reviews: feedback.reviews.map((review) => ({
        ...review,
        id: "102",
        event: "APPROVED" as const,
      })),
    };
    const incomplete = { ...feedback, complete: false };
    const edit = { ...input, commentId: "201", body: "edited" };
    const remove = { ...input, commentId: "201", confirmation: true };
    const dismiss = {
      ...input,
      publishedReviewId: "101",
      message: "stale",
      confirmation: true,
    };

    it("a refused edit is final with no landed-check read and releases the lock", async () => {
      const built = fixture({ write: async () => refusal("unprocessable") });
      await expect(built.service.editComment(edit)).resolves.toEqual(
        refusedWith("unprocessable"),
      );
      expect(
        built.trace.filter((entry) => entry === "authorization"),
      ).toHaveLength(1);
      expect(built.operation()).toBeUndefined();
      expect(built.operations.reject).toHaveBeenCalledOnce();
      expect(built.appendConfirmed).not.toHaveBeenCalled();
      await built.service.editComment(edit);
      expect(built.writer).toHaveBeenCalledTimes(2);
    });

    it("keeps the lock when a final refusal cannot be recorded", async () => {
      const built = fixture({ write: async () => refusal("unprocessable") });
      built.operations.reject.mockResolvedValueOnce(
        // SAFETY: the service only checks the result tag of a failed rejection.
        err({ _tag: "StorageFailure" } as never),
      );
      await expect(built.service.editComment(edit)).resolves.toEqual(
        outcomeUnknown,
      );
      expect(built.operation()?.state).toMatchObject(lockedState);
    });

    it("a refused delete is refused and unlocked while the comment still exists", async () => {
      const built = fixture({
        write: async () => refusal("not_found"),
        feedbackReads: [feedback],
      });
      await expect(built.service.deleteComment(remove)).resolves.toEqual(
        refusedWith("not_found"),
      );
      expect(built.operation()).toBeUndefined();
      await built.service.deleteComment(remove);
      expect(built.writer).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["the comment is gone", [feedback, withoutComment]],
      ["only a different comment remains", [feedback, withOtherComment]],
      ["the read after the refusal fails", [feedback, "failure"]],
      ["the read after the refusal is incomplete", [feedback, incomplete]],
    ] as const)(
      "a refused delete stays outcome unknown when %s",
      async (_name, feedbackReads) => {
        const built = fixture({
          write: async () => refusal("not_found"),
          feedbackReads,
        });
        await expect(built.service.deleteComment(remove)).resolves.toEqual(
          outcomeUnknown,
        );
        expect(built.operation()?.state).toMatchObject(lockedState);
        expect(built.operations.reject).not.toHaveBeenCalled();
      },
    );

    it("a refused dismissal is refused and unlocked while the review is not dismissed", async () => {
      const built = fixture({
        write: async () => refusal("unprocessable"),
        feedbackReads: [withReview("APPROVED")],
      });
      await expect(built.service.dismissReview(dismiss)).resolves.toEqual(
        refusedWith("unprocessable"),
      );
      expect(built.operation()).toBeUndefined();
    });

    it.each([
      [
        "the review reads dismissed",
        [withReview("APPROVED"), withReview("DISMISSED")],
      ],
      [
        "the review is missing",
        [withReview("APPROVED"), { ...feedback, reviews: [] }],
      ],
      [
        "only a different review remains",
        [withReview("APPROVED"), withOtherReview],
      ],
      ["the read after the refusal fails", [withReview("APPROVED"), "failure"]],
      [
        "the read after the refusal is incomplete",
        [withReview("APPROVED"), incomplete],
      ],
    ] as const)(
      "a refused dismissal stays outcome unknown when %s",
      async (_name, feedbackReads) => {
        const built = fixture({
          write: async () => refusal("unprocessable"),
          feedbackReads,
        });
        await expect(built.service.dismissReview(dismiss)).resolves.toEqual(
          outcomeUnknown,
        );
        expect(built.operation()?.state).toMatchObject(lockedState);
      },
    );

    it("is final for an unsupported endpoint with no read", async () => {
      const built = fixture({
        write: async () => refusal("unsupported"),
        feedbackReads: [feedback, withoutComment],
      });
      await expect(built.service.deleteComment(remove)).resolves.toEqual(
        refusedWith("unsupported"),
      );
      expect(
        built.trace.filter((entry) => entry === "authorization"),
      ).toHaveLength(1);
    });

    it("exposes the refusal as a class the route can recognize", async () => {
      const built = fixture({
        write: async () => refusal("conflict" as never),
      });
      const result = await built.service.editComment(edit);
      expect(result._tag === "err" && result.error).toBeInstanceOf(
        GitHubRefusedPublishedFeedbackWrite,
      );
    });
  });

  it("returns confirmed success with reconciliation required when refresh fails", async () => {
    const built = fixture({
      refresh: async () => err({ reason: "github_read" }),
    });
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
