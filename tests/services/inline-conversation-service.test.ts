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
import { ok, type Result } from "../../src/domain/result";
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
    ok({ session: { key: sessionKey }, profile: {} } as never),
  ),
});

const expected = { sessionId: "session-a", headSha, patchHash: "patch-hash" };

function command(
  overrides: Partial<DirectConversationCommand>,
): DirectConversationCommand {
  return {
    _tag: "Reply",
    expected,
    threadId: "PRRT_thread",
    body: "A reply",
    ...overrides,
  } as DirectConversationCommand;
}

function makeGateway(overrides: Record<string, unknown> = {}) {
  const github = {
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
  it("proves a Reply's thread belongs to the active Review before mutating", async () => {
    const gate = makeGate();
    const createThreadReply = vi.fn();
    const getReviewThreadTarget = vi.fn(async () => ok({ found: false }));
    const service = new InlineConversationService(
      gate,
      makeGateway({ createThreadReply, getReviewThreadTarget }) as never,
      new ReviewOperationCoordinator(),
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
      makeGateway({ setReviewThreadState, getReviewThreadTarget }) as never,
      new ReviewOperationCoordinator(),
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
      makeGateway({ createThreadReply, getReviewThreadTarget }) as never,
      new ReviewOperationCoordinator(),
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
      makeGateway({ getPullRequestComments, createThreadReply }) as never,
      new ReviewOperationCoordinator(),
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
      makeGateway({ updateThreadComment, getReviewCommentTarget }) as never,
      new ReviewOperationCoordinator(),
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
      makeGateway({ updateThreadComment, getReviewCommentTarget }) as never,
      new ReviewOperationCoordinator(),
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
      makeGateway({ createThreadReply }) as never,
      coordinator,
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
      makeGateway() as never,
      coordinator,
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
      makeGateway({ createThreadReply }) as never,
      new ReviewOperationCoordinator(),
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
        profile: {} as never,
        pr: fixturePr,
        threadId,
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: true } });
    await expect(
      adapter.getReviewThreadTarget({
        profile: {} as never,
        pr: foreignPr,
        threadId,
      }),
    ).resolves.toEqual({ _tag: "ok", value: { found: false } });
    await expect(
      adapter.getReviewCommentTarget({
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
      pullRequest: { headSha } as never,
      threadTargets: [{ threadId, pr: foreignPr }],
    });
    const gate = makeGate();
    const service = new InlineConversationService(
      gate,
      adapter,
      new ReviewOperationCoordinator(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ _tag: "Reply", threadId: "PRRT_thread" }),
    });
    expect(result).toEqual({ _tag: "err", error: "not_found" });
  });
});
