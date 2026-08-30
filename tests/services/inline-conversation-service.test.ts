import { describe, expect, it, vi } from "vitest";

import {
  InlineConversationService,
  type DirectConversationCommand,
} from "../../src/services/inline-conversation-service";
import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubThreadId,
  parseGitSha,
  parsePullRequestNumber,
  parseReviewId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import type { ReviewWriteOperation } from "../../src/domain/review-write-operation";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const reviewId = must(
  parseReviewId("cfw__centraldigital__patchdesk__pr-42__review-abcdef123456"),
);
const headSha = must(parseGitSha("1".repeat(40)));
const sessionKey = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
  headSha,
};

/** Minimal fresh gate: every command passes freshness against the fixture head. */
const makeGate = () => ({
  requireFresh: vi.fn(async () =>
    // SAFETY: the service only reads `session.key` from this stub; `profile`
    // is forwarded opaquely into the gateway mocks below, which ignore it.
    ok({
      session: { key: sessionKey },
      profile: { ghAccount: "reviewer" },
    } as never),
  ),
});

const expected = { sessionId: "session-a", headSha, patchHash: "patch-hash" };
// SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
// branded IsoTimestamp contract the service's `now` dependency expects.
const now = () => "2026-01-01T00:00:00.000Z" as never;
const makeRecentWrites = () => ({ append: vi.fn(async () => ok(undefined)) });

function makeOperations() {
  let current: ReviewWriteOperation | undefined;
  return {
    load: vi.fn(async () => ok(current)),
    begin: vi.fn(async (operation: ReviewWriteOperation) => {
      if (current !== undefined)
        return err({ _tag: "ReviewWriteOperationExists" as const });
      current = operation;
      return ok(undefined);
    }),
    markOutcomeUnknown: vi.fn(async (operation: ReviewWriteOperation) => {
      current = operation;
      return ok(undefined);
    }),
    confirm: vi.fn(async (operation: ReviewWriteOperation) => {
      current = operation;
      return ok(undefined);
    }),
    reject: vi.fn(async () => {
      current = undefined;
      return ok(undefined);
    }),
    remove: vi.fn(async () => {
      current = undefined;
      return ok(undefined);
    }),
    current: () => current,
  };
}

function command(
  overrides: Partial<DirectConversationCommand>,
): DirectConversationCommand {
  // SAFETY: `overrides` can switch `_tag` to any DirectConversationCommand
  // variant; each call site only sets the fields that variant requires, and
  // the resulting command is exercised (not just constructed) by the test.
  return {
    _tag: "Reply",
    expected,
    threadId: "PRRT_thread",
    body: "A reply",
    ...overrides,
  } as DirectConversationCommand;
}

function makeGateway(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const github = {
    // SAFETY: only `headSha` is read from this stub by the service's
    // current-head freshness check; the rest of PullRequestSummary is unused.
    getPullRequest: vi.fn(async () => ok({ headSha } as never)),
    getPullRequestComments: vi.fn(async () =>
      ok({ threads: [], complete: true }),
    ),
    getReviewThreadTarget: vi.fn(async () => ok({ found: true })),
    getReviewCommentTarget: vi.fn(async () =>
      ok({ found: true, viewerDidAuthor: true }),
    ),
    createInlineComment: vi.fn(),
    createThreadReply: vi.fn(),
    setReviewThreadState: vi.fn(),
    updateThreadComment: vi.fn(),
    deleteThreadComment: vi.fn(),
    ...overrides,
  };
  return github;
}

describe("InlineConversationService", () => {
  it("refuses a write as not_fresh when GitHub reports a moved head", async () => {
    const gate = makeGate();
    const createThreadReply = vi.fn();
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({
        createThreadReply,
        // SAFETY: this literal is a 40-character hex string, matching parseGitSha's format.
        getPullRequest: vi.fn(async () => ok({ headSha: "c".repeat(40) })),
      }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_any" }),
    });
    expect(result).toEqual({ _tag: "err", error: "not_fresh" });
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("proves a Reply's thread belongs to the active Review before mutating", async () => {
    const gate = makeGate();
    const createThreadReply = vi.fn();
    const getReviewThreadTarget = vi.fn(async () => ok({ found: false }));
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ createThreadReply, getReviewThreadTarget }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_foreign" }),
    });
    expect(result).toEqual({ _tag: "err", error: "not_found" });
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("proves a SetThreadState target belongs to the active Review before mutating", async () => {
    const gate = makeGate();
    const setReviewThreadState = vi.fn();
    const getReviewThreadTarget = vi.fn(async () => ok({ found: false }));
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ setReviewThreadState, getReviewThreadTarget }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "SetThreadState",
        threadId: "PRRT_foreign",
        state: "resolved",
      }),
    });
    expect(result).toEqual({ _tag: "err", error: "not_found" });
    expect(setReviewThreadState).not.toHaveBeenCalled();
  });

  it("maps a target-proof read failure without mutating", async () => {
    const gate = makeGate();
    const createThreadReply = vi.fn();
    const getReviewThreadTarget = vi.fn(async () => ({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_thread_target" },
    }));
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ createThreadReply, getReviewThreadTarget }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_any" }),
    });
    expect(result).toEqual({ _tag: "err", error: "github_read_failed" });
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("never reads the full pull-request conversation to prove a Reply target", async () => {
    const gate = makeGate();
    const getPullRequestComments = vi.fn(async () =>
      ok({ threads: [], complete: true }),
    );
    const createThreadReply = vi.fn(async () =>
      ok({ commentId: "PRRC_reply", reviewId: "PRR_1" }),
    );
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ getPullRequestComments, createThreadReply }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_thread" }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: {
        _tag: "ReplyCreated",
        commentId: "PRRC_reply",
        reviewId: "PRR_1",
      },
    });
    expect(getPullRequestComments).not.toHaveBeenCalled();
  });

  it("rejects editing a comment the viewer did not author without mutating", async () => {
    const gate = makeGate();
    const updateThreadComment = vi.fn();
    const getReviewCommentTarget = vi.fn(async () =>
      ok({ found: true, viewerDidAuthor: false }),
    );
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ updateThreadComment, getReviewCommentTarget }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "EditComment",
        commentId: "PRRC_other",
        body: "edit",
      }),
    });
    expect(result).toEqual({ _tag: "err", error: "permission_denied" });
    expect(updateThreadComment).not.toHaveBeenCalled();
  });

  it("rejects editing a comment outside the active Review without mutating", async () => {
    const gate = makeGate();
    const updateThreadComment = vi.fn();
    const getReviewCommentTarget = vi.fn(async () => ok({ found: false }));
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ updateThreadComment, getReviewCommentTarget }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "EditComment",
        commentId: "PRRC_foreign",
        body: "edit",
      }),
    });
    expect(result).toEqual({ _tag: "err", error: "not_found" });
    expect(updateThreadComment).not.toHaveBeenCalled();
  });
  it("does not enter while a direct-summary write owns the Review write coordinator", async () => {
    const gate = makeGate();
    const createThreadReply = vi.fn(async () =>
      ok({ commentId: "PRRC_reply" }),
    );
    const coordinator = new ReviewOperationCoordinator();
    const key = `${profileId}:${reviewId}`;
    expect(coordinator.acquire(key)).toBe(true);
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ createThreadReply }) as never,
      coordinator,
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_thread" }),
    });
    expect(result).toEqual({ _tag: "err", error: "review_write_in_progress" });
    expect(createThreadReply).not.toHaveBeenCalled();
    coordinator.release(key);
  });

  it("validates local commands before checking the shared coordinator", async () => {
    const gate = makeGate();
    const coordinator = new ReviewOperationCoordinator();
    const key = `${profileId}:${reviewId}`;
    expect(coordinator.acquire(key)).toBe(true);
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway() as never,
      coordinator,
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ _tag: "Reply", body: "   " }),
    });
    expect(result).toEqual({ _tag: "err", error: "invalid_input" });
    expect(gate.requireFresh).not.toHaveBeenCalled();
    coordinator.release(key);
  });

  it("performs exactly one mutation for a proven Reply", async () => {
    const gate = makeGate();
    const createThreadReply = vi.fn(async () =>
      ok({ commentId: "PRRC_reply" }),
    );
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ createThreadReply }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "Reply",
        threadId: "PRRT_thread",
        body: "Proven",
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: { _tag: "ReplyCreated", commentId: "PRRC_reply" },
    });
    expect(createThreadReply).toHaveBeenCalledOnce();
    expect(createThreadReply).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "PRRT_thread", body: "Proven" }),
    );
  });

  it("passes through a created comment's confirmed threadId", async () => {
    const gate = makeGate();
    const createInlineComment = vi.fn(async () =>
      ok({ commentId: "PRRC_new", reviewId: "PRR_1", threadId: "PRRT_new" }),
    );
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ createInlineComment }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "CreateComment",
        anchor: { path: "src/a.ts", startLine: 5, line: 5, side: "new" },
        body: "New comment",
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: {
        _tag: "CommentCreated",
        commentId: "PRRC_new",
        reviewId: "PRR_1",
        threadId: "PRRT_new",
      },
    });
  });

  it("surfaces a forbidden inline comment write as 'forbidden', not the generic 'github_write_failed'", async () => {
    const gate = makeGate();
    const createInlineComment = vi.fn(async () => ({
      _tag: "err" as const,
      error: { category: "forbidden" as const },
    }));
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ createInlineComment }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "CreateComment",
        anchor: { path: "src/a.ts", startLine: 5, line: 5, side: "new" },
        body: "New comment",
      }),
    });
    expect(result).toEqual({ _tag: "err", error: "forbidden" });
  });

  it("never synthesizes a threadId when the create receipt did not confirm one", async () => {
    const gate = makeGate();
    const createInlineComment = vi.fn(async () =>
      ok({ commentId: "PRRC_new" }),
    );
    const service = new InlineConversationService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ createInlineComment }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "CreateComment",
        anchor: { path: "src/a.ts", startLine: 5, line: 5, side: "new" },
        body: "New comment",
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: { _tag: "CommentCreated", commentId: "PRRC_new" },
    });
  });
});

describe("InlineConversationService durable write lifecycle", () => {
  it("retains a rejected writer promise as outcome-unknown and blocks a later write", async () => {
    const operations = makeOperations();
    const createThreadReply = vi.fn(async () => {
      throw new Error("transport rejected after dispatch");
    });
    const service = new InlineConversationService(
      makeGate(),
      // SAFETY: this gateway fixture implements every method exercised by the rejected reply lifecycle.
      makeGateway({ createThreadReply }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      operations,
    );
    const input = {
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_thread" }),
    };

    await expect(service.execute(input)).resolves.toEqual({
      _tag: "err",
      error: "outcome_unknown",
    });
    expect(operations.current()?.state).toEqual({
      _tag: "OutcomeUnknown",
      resolution: "check_required",
    });
    await expect(service.execute(input)).resolves.toEqual({
      _tag: "err",
      error: "outcome_unknown",
    });
    expect(createThreadReply).toHaveBeenCalledOnce();
  });

  it("removes a deterministically rejected operation so a corrected command can retry", async () => {
    const operations = makeOperations();
    const createThreadReply = vi
      .fn()
      .mockResolvedValueOnce(
        err({
          _tag: "GitHubWriteFailure",
          category: "forbidden",
          message: "forbidden",
        }),
      )
      .mockResolvedValueOnce(ok({ commentId: "PRRC_retry" }));
    const service = new InlineConversationService(
      makeGate(),
      // SAFETY: this gateway fixture implements every method exercised by the rejected-then-corrected reply lifecycle.
      makeGateway({ createThreadReply }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      operations,
    );
    const input = {
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_thread" }),
    };

    await expect(service.execute(input)).resolves.toEqual({
      _tag: "err",
      error: "forbidden",
    });
    expect(operations.current()).toBeUndefined();
    await expect(service.execute(input)).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "ReplyCreated", commentId: "PRRC_retry" },
    });
    expect(createThreadReply).toHaveBeenCalledTimes(2);
  });

  it("retains an unavailable reply as outcome-unknown and blocks a second write", async () => {
    const operations = makeOperations();
    const createThreadReply = vi.fn(async () =>
      err({
        _tag: "GitHubWriteFailure" as const,
        category: "unavailable" as const,
        message: "lost response",
      }),
    );
    const service = new InlineConversationService(
      makeGate(),
      // SAFETY: this gateway fixture implements every method exercised by the unavailable reply lifecycle.
      makeGateway({ createThreadReply }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      operations,
    );
    const input = {
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_thread" }),
    };
    await expect(service.execute(input)).resolves.toEqual({
      _tag: "err",
      error: "outcome_unknown",
    });
    expect(operations.current()?.state).toEqual({
      _tag: "OutcomeUnknown",
      resolution: "check_required",
    });
    await expect(service.execute(input)).resolves.toEqual({
      _tag: "err",
      error: "outcome_unknown",
    });
    expect(createThreadReply).toHaveBeenCalledOnce();
  });

  it("confirms a delete without appending a misleading comment-exists receipt", async () => {
    const operations = makeOperations();
    const append = vi.fn(async () => ok(undefined));
    const deleteThreadComment = vi.fn(async () => ok(undefined));
    const service = new InlineConversationService(
      makeGate(),
      // SAFETY: this gateway fixture implements every method exercised by the confirmed delete lifecycle.
      makeGateway({ deleteThreadComment }) as never,
      new ReviewOperationCoordinator(),
      now,
      { append },
      operations,
    );
    await expect(
      service.execute({
        profileId,
        reviewId,
        command: command({
          _tag: "DeleteComment",
          commentId: "PRRC_comment",
          confirmation: true,
        }),
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "CommentDeleted", commentId: "PRRC_comment" },
    });
    expect(operations.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ state: { _tag: "Confirmed" } }),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("persists confirmation and the recent-write receipt before clearing the operation", async () => {
    const operations = makeOperations();
    const append = vi.fn(async () => ok(undefined));
    const createThreadReply = vi.fn(async () =>
      ok({ commentId: "PRRC_reply", reviewId: "PRR_review" }),
    );
    const service = new InlineConversationService(
      makeGate(),
      // SAFETY: this gateway fixture implements every method exercised by the confirmed reply lifecycle.
      makeGateway({ createThreadReply }) as never,
      new ReviewOperationCoordinator(),
      now,
      { append },
      operations,
    );
    await expect(
      service.execute({
        profileId,
        reviewId,
        command: command({ _tag: "Reply", threadId: "PRRT_thread" }),
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        _tag: "ReplyCreated",
        commentId: "PRRC_reply",
        reviewId: "PRR_review",
      },
    });
    expect(operations.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {
          _tag: "Confirmed",
          receipt: {
            _tag: "Comment",
            commentId: "PRRC_reply",
            reviewId: "PRR_review",
          },
        },
      }),
    );
    expect(append).toHaveBeenCalledWith(
      profileId,
      reviewId,
      {
        _tag: "Comment",
        commentId: "PRRC_reply",
        reviewId: "PRR_review",
      },
      now(),
    );
    expect(operations.current()).toBeUndefined();
  });
});

describe("FakeGitHubAdapter ownership parity", () => {
  const fixturePr = {
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("centraldigital")),
    repo: must(parseGitHubRepoName("patchdesk")),
    number: must(parsePullRequestNumber(42)),
  };
  const foreignPr = { ...fixturePr, number: must(parsePullRequestNumber(99)) };
  const threadId = must(parseGitHubThreadId("PRRT_thread"));

  it("returns found only for a target scoped to the requested pull request", async () => {
    const adapter = new FakeGitHubAdapter({
      threadTargets: [{ threadId, pr: fixturePr }],
      commentTargets: [
        { commentId: "PRRC_comment", viewerDidAuthor: true, pr: fixturePr },
      ],
    });
    await expect(
      adapter.getReviewThreadTarget({
        // SAFETY: FakeGitHubAdapter's target lookups match on `pr` only;
        // `profile` is accepted but never read.
        profile: {} as never,
        pr: fixturePr,
        threadId,
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: true } });
    await expect(
      adapter.getReviewThreadTarget({
        // SAFETY: FakeGitHubAdapter's target lookups match on `pr` only;
        // `profile` is accepted but never read.
        profile: {} as never,
        pr: foreignPr,
        threadId,
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
    await expect(
      adapter.getReviewCommentTarget({
        // SAFETY: FakeGitHubAdapter's target lookups match on `pr` only;
        // `profile` is accepted but never read.
        profile: {} as never,
        pr: fixturePr,
        commentId: "PRRC_comment",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { found: true, viewerDidAuthor: true },
    });
    await expect(
      adapter.getReviewCommentTarget({
        // SAFETY: FakeGitHubAdapter's target lookups match on `pr` only;
        // `profile` is accepted but never read.
        profile: {} as never,
        pr: foreignPr,
        commentId: "PRRC_comment",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
  });

  it("never lets a reused id from another pull request reach a mutation", async () => {
    // The thread id is registered in the fake under a different pull request
    // than the active Review session, exactly the cross-PR reuse scenario.
    const adapter = new FakeGitHubAdapter({
      // SAFETY: only `headSha` is read from this stub by the service's
      // current-head freshness check; the rest of PullRequestSummary is unused.
      pullRequest: { headSha } as never,
      threadTargets: [{ threadId, pr: foreignPr }],
    });
    const gate = makeGate();
    const service = new InlineConversationService(
      gate,
      adapter,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      makeOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_thread" }),
    });
    expect(result).toEqual({ _tag: "err", error: "not_found" });
  });
});
