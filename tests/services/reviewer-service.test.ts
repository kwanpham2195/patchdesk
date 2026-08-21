import { describe, expect, it, vi } from "vitest";

import {
  ReviewerService,
  type ReviewerCommand,
} from "../../src/services/reviewer-service";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
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

/** Minimal current-session gate: every command passes against the fixture review. */
const makeGate = () => ({
  requireCurrentSession: vi.fn(async () =>
    // SAFETY: the service only reads `session.key` and `profile.ghAccount`
    // from this stub; `review` is forwarded opaquely and never read.
    ok({
      profile: { ghAccount: "octocat" },
      review: {},
      session: { key: sessionKey },
    } as never),
  ),
});

// SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
// branded IsoTimestamp contract the service's `now` dependency expects.
const now = () => "2026-01-01T00:00:00.000Z" as never;
const makeRecentWrites = () => ({ append: vi.fn(async () => ok(undefined)) });

function command(overrides: Partial<ReviewerCommand> = {}): ReviewerCommand {
  // SAFETY: `overrides` can switch `_tag` to any ReviewerCommand variant;
  // each call site only sets the fields that variant requires, and the
  // resulting command is exercised (not just constructed) by the test.
  return {
    _tag: "RequestReviewers",
    reviewers: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
    ...overrides,
  } as ReviewerCommand;
}

function makeGateway(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const github = {
    resolveAuthenticatedAccount: vi.fn(async () =>
      ok({ host: "github.com", account: "octocat" }),
    ),
    getRepositoryPermission: vi.fn(async () =>
      ok({
        account: "octocat",
        permission: "write" as const,
        pullRequestsWrite: true,
        canManageLabels: true,
      }),
    ),
    // SAFETY: the service only reads `nodeId` from this stub.
    getPullRequest: vi.fn(async () => ok({ nodeId: "PR_node" } as never)),
    getPullRequestReviewers: vi.fn(async () =>
      ok({ requested: [], latestReviews: [], reviews: [], suggested: [] }),
    ),
    listAssignableUsers: vi.fn(async () => ok({ users: [], totalCount: 0 })),
    requestReviews: vi.fn(async () => ok(undefined)),
    removeRequestedReviewers: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
  return github;
}

describe("ReviewerService", () => {
  it("requests reviewers and journals the confirmed write", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn(async () => ok(undefined));
    const recentWrites = makeRecentWrites();
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews }) as never,
      new ReviewOperationCoordinator(),
      now,
      recentWrites,
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "RequestReviewers",
        reviewers: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: { _tag: "ReviewersRequested", requested: ["octocat"] },
    });
    expect(requestReviews).toHaveBeenCalledOnce();
    expect(requestReviews).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestId: "PR_node",
        userIds: ["MDQ6VXNlcjE="],
      }),
    );
    expect(recentWrites.append).toHaveBeenCalledOnce();
    expect(recentWrites.append).toHaveBeenCalledWith(
      profileId,
      reviewId,
      { _tag: "ReviewerChange", requested: ["octocat"], removed: [] },
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("removes reviewers via the subtractive REST path, never a whole-set replacement, and journals the confirmed write", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn(async () => ok(undefined));
    const removeRequestedReviewers = vi.fn(async () => ok(undefined));
    const recentWrites = makeRecentWrites();
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews, removeRequestedReviewers }) as never,
      new ReviewOperationCoordinator(),
      now,
      recentWrites,
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "RemoveReviewers",
        reviewers: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: { _tag: "ReviewersRemoved", removed: ["octocat"] },
    });
    // The subtractive path only, carrying exactly the removed logins — not
    // GitHub's `requestReviews` (which replaces the whole set) resent with
    // some computed "remaining reviewers" array.
    expect(requestReviews).not.toHaveBeenCalled();
    expect(removeRequestedReviewers).toHaveBeenCalledOnce();
    expect(removeRequestedReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ logins: ["octocat"] }),
    );
    expect(recentWrites.append).toHaveBeenCalledWith(
      profileId,
      reviewId,
      { _tag: "ReviewerChange", requested: [], removed: ["octocat"] },
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("requests additively: it never reads the pull request's existing reviewer set before calling GitHub's own union:true mutation", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn(async () => ok(undefined));
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
    );
    await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "RequestReviewers",
        reviewers: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
      }),
    });
    // Only the command's own reviewers travel to GitHub; the additive
    // `union: true` semantics live in the mutation itself (see
    // `requestReviewsMutation`), so the service has no "existing reviewers"
    // to merge in.
    expect(requestReviews).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ["MDQ6VXNlcjE="] }),
    );
  });

  it("does not journal a failed write", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn(async () => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "unavailable" as const,
        message: "x",
      },
    }));
    const recentWrites = makeRecentWrites();
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews }) as never,
      new ReviewOperationCoordinator(),
      now,
      recentWrites,
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command(),
    });
    expect(result).toEqual({ _tag: "err", error: "github_write_failed" });
    expect(recentWrites.append).not.toHaveBeenCalled();
  });

  it("surfaces which reviewer a failed request write was for, via the exact write call arguments", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn(async () => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "unavailable" as const,
        message: "x",
      },
    }));
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "RequestReviewers",
        reviewers: [{ id: "U_target", login: "target-reviewer" }],
      }),
    });
    expect(result).toEqual({ _tag: "err", error: "github_write_failed" });
    // The failure is generic, but the write attempt itself still names
    // exactly who it was for — the service never loses or substitutes the
    // target identity on a failed write.
    expect(requestReviews).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ["U_target"] }),
    );
  });

  it("refuses a write when permission is explicitly denied", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn();
    const getRepositoryPermission = vi.fn(async () =>
      ok({
        account: "octocat",
        permission: "triage" as const,
        pullRequestsWrite: false,
        canManageLabels: true,
      }),
    );
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews, getRepositoryPermission }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command(),
    });
    expect(result).toEqual({ _tag: "err", error: "permission_denied" });
    expect(requestReviews).not.toHaveBeenCalled();
  });

  it("refuses a write when permission is unknown, never treating unknown as permitted", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn();
    // No `getRepositoryPermission` implementation at all is the adapter's
    // real-world "unknown" shape (an optional method the reader never wired up).
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({
        requestReviews,
        getRepositoryPermission: undefined as never,
      }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command(),
    });
    expect(result).toEqual({ _tag: "err", error: "permission_denied" });
    expect(requestReviews).not.toHaveBeenCalled();
  });

  it("surfaces a forbidden reviewer write as 'forbidden', not the generic 'github_write_failed'", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn(async () => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "forbidden" as const,
        message: "blocked",
        reason: "saml" as const,
      },
    }));
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command(),
    });
    expect(result).toEqual({ _tag: "err", error: "forbidden" });
  });

  it("rejects an empty reviewer list before checking permission", async () => {
    const gate = makeGate();
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway() as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({ reviewers: [] }),
    });
    expect(result).toEqual({ _tag: "err", error: "invalid_input" });
    expect(gate.requireCurrentSession).not.toHaveBeenCalled();
  });

  it("does not enter while another write owns the Review write coordinator", async () => {
    const gate = makeGate();
    const requestReviews = vi.fn(async () => ok(undefined));
    const coordinator = new ReviewOperationCoordinator();
    const key = `${profileId}:${reviewId}`;
    expect(coordinator.acquire(key)).toBe(true);
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews }) as never,
      coordinator,
      now,
      makeRecentWrites(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command(),
    });
    expect(result).toEqual({ _tag: "err", error: "review_write_in_progress" });
    expect(requestReviews).not.toHaveBeenCalled();
    coordinator.release(key);
  });

  it("gates on the current session, not on patch freshness — a stale gate response still refuses the write", async () => {
    const gate = {
      requireCurrentSession: vi.fn(async () => ({
        _tag: "err" as const,
        error: { reason: "terminal" as const },
      })),
    };
    const requestReviews = vi.fn();
    const service = new ReviewerService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ requestReviews }) as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command(),
    });
    expect(result).toEqual({ _tag: "err", error: "permission_denied" });
    expect(gate.requireCurrentSession).toHaveBeenCalledOnce();
    expect(requestReviews).not.toHaveBeenCalled();
  });

  describe("list", () => {
    it("reaches the renderer with reviewer verdicts, suggestions, and candidates intact", async () => {
      const gate = makeGate();
      const getPullRequestReviewers = vi.fn(async () =>
        ok({
          requested: [{ login: "requested-only" }],
          latestReviews: [
            {
              login: "octocat",
              state: "APPROVED" as const,
              // SAFETY: this literal is a well-formed ISO 8601 instant,
              // satisfying the branded IsoTimestamp contract this field expects.
              submittedAt: "2026-01-01T00:00:00.000Z" as never,
              commitOid: headSha,
            },
          ],
          reviews: [],
          suggested: [
            {
              isAuthor: false,
              isCommenter: true,
              reviewer: { login: "suggested-one" },
            },
          ],
        }),
      );
      const listAssignableUsers = vi.fn(async () =>
        ok({
          users: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
          totalCount: 1,
        }),
      );
      const service = new ReviewerService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({
          getPullRequestReviewers,
          listAssignableUsers,
        }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result._tag).toBe("ok");
      if (result._tag !== "ok" || result.value._tag !== "ready")
        throw new Error("expected a ready outcome");
      expect(result.value.reviewers).toEqual([
        {
          login: "octocat",
          verdict: "approved",
          outdated: false,
          submittedAt: "2026-01-01T00:00:00.000Z",
        },
        { login: "requested-only", outdated: false },
      ]);
      expect(result.value.suggested).toEqual([
        {
          isAuthor: false,
          isCommenter: true,
          reviewer: { login: "suggested-one" },
        },
      ]);
      expect(result.value.candidates).toEqual([
        { id: "MDQ6VXNlcjE=", login: "octocat" },
      ]);
      expect(result.value.candidatesTotalCount).toBe(1);
      expect(result.value.permission).toBe("permitted");
    });

    it("carries 'unknown' onto the read outcome when permission evidence is unavailable, never 'permitted'", async () => {
      const gate = makeGate();
      const service = new ReviewerService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({
          // No `getRepositoryPermission` implementation is the adapter's
          // real-world "unknown" shape (an optional method left unwired).
          getRepositoryPermission: undefined as never,
        }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result._tag).toBe("ok");
      if (result._tag !== "ok" || result.value._tag !== "ready")
        throw new Error("expected a ready outcome");
      expect(result.value.permission).toBe("unknown");
    });

    it("surfaces a forbidden reviewer read as its specific reason, not a generic failure", async () => {
      const gate = makeGate();
      const getPullRequestReviewers = vi.fn(async () => ({
        _tag: "err" as const,
        error: {
          _tag: "GitHubForbidden" as const,
          operation: "get_pull_request_reviewers" as const,
          reason: "saml" as const,
        },
      }));
      const service = new ReviewerService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ getPullRequestReviewers }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({
        _tag: "ok",
        value: { _tag: "github_forbidden", reason: "saml" },
      });
    });

    it("surfaces a rate-limited reviewer read with its resume time, not a generic failure", async () => {
      const gate = makeGate();
      const resumeAt = "2026-01-01T01:00:00.000Z";
      const getPullRequestReviewers = vi.fn(async () => ({
        _tag: "err" as const,
        error: {
          _tag: "GitHubRateLimited" as const,
          operation: "get_pull_request_reviewers" as const,
          // SAFETY: this literal is a well-formed ISO 8601 instant,
          // satisfying the branded IsoTimestamp contract this field expects.
          resumeAt: resumeAt as never,
        },
      }));
      const service = new ReviewerService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ getPullRequestReviewers }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({
        _tag: "ok",
        value: { _tag: "github_rate_limited", resumeAt },
      });
    });

    it("surfaces an auth failure on the reviewer read as data, not an HTTP error", async () => {
      const gate = makeGate();
      const getPullRequestReviewers = vi.fn(async () => ({
        _tag: "err" as const,
        error: {
          _tag: "GitHubAuthenticationFailed" as const,
          operation: "get_pull_request_reviewers" as const,
        },
      }));
      const service = new ReviewerService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ getPullRequestReviewers }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({ _tag: "ok", value: { _tag: "github_auth" } });
    });

    it("surfaces a plain read failure on the candidate list as data, not an HTTP error", async () => {
      const gate = makeGate();
      const listAssignableUsers = vi.fn(async () => ({
        _tag: "err" as const,
        error: {
          _tag: "GitHubReadFailed" as const,
          operation: "list_assignable_users" as const,
        },
      }));
      const service = new ReviewerService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listAssignableUsers }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({ _tag: "ok", value: { _tag: "github_read" } });
    });

    it("refuses without listing when the review cannot be resolved", async () => {
      const gate = {
        requireCurrentSession: vi.fn(async () => ({
          _tag: "err" as const,
          error: { reason: "not_found" as const },
        })),
      };
      const getPullRequestReviewers = vi.fn();
      const service = new ReviewerService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ getPullRequestReviewers }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({ _tag: "err", error: "not_found" });
      expect(getPullRequestReviewers).not.toHaveBeenCalled();
    });
  });
});
