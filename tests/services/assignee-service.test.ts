import { describe, expect, it, vi } from "vitest";

import {
  AssigneeService,
  type AssigneeCommand,
} from "../../src/services/assignee-service";
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

function command(overrides: Partial<AssigneeCommand> = {}): AssigneeCommand {
  // SAFETY: `overrides` can switch `_tag` to any AssigneeCommand variant;
  // each call site only sets the fields that variant requires, and the
  // resulting command is exercised (not just constructed) by the test.
  return {
    _tag: "AddAssignees",
    assignees: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
    ...overrides,
  } as AssigneeCommand;
}

function makeGateway(
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
  existingAssignees: ReadonlyArray<string> = [],
) {
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
    // SAFETY: the service only reads `nodeId`/`assignees` from this stub.
    getPullRequest: vi.fn(async () =>
      ok({ nodeId: "PR_node", assignees: existingAssignees } as never),
    ),
    addAssigneesToAssignable: vi.fn(async () => ok(undefined)),
    removeAssigneesFromAssignable: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
  return github;
}

describe("AssigneeService", () => {
  it("adds assignees and journals the confirmed write", async () => {
    const gate = makeGate();
    const addAssigneesToAssignable = vi.fn(async () => ok(undefined));
    const recentWrites = makeRecentWrites();
    const service = new AssigneeService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addAssigneesToAssignable }) as never,
      new ReviewOperationCoordinator(),
      now,
      recentWrites,
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "AddAssignees",
        assignees: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: { _tag: "AssigneesAdded", added: ["octocat"] },
    });
    expect(addAssigneesToAssignable).toHaveBeenCalledOnce();
    expect(addAssigneesToAssignable).toHaveBeenCalledWith(
      expect.objectContaining({
        assignableId: "PR_node",
        assigneeIds: ["MDQ6VXNlcjE="],
      }),
    );
    expect(recentWrites.append).toHaveBeenCalledOnce();
    expect(recentWrites.append).toHaveBeenCalledWith(
      profileId,
      reviewId,
      { _tag: "AssigneeChange", added: ["octocat"], removed: [] },
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("removes assignees and journals the confirmed write", async () => {
    const gate = makeGate();
    const removeAssigneesFromAssignable = vi.fn(async () => ok(undefined));
    const recentWrites = makeRecentWrites();
    const service = new AssigneeService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ removeAssigneesFromAssignable }, ["octocat"]) as never,
      new ReviewOperationCoordinator(),
      now,
      recentWrites,
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "RemoveAssignees",
        assignees: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: { _tag: "AssigneesRemoved", removed: ["octocat"] },
    });
    expect(removeAssigneesFromAssignable).toHaveBeenCalledOnce();
    expect(recentWrites.append).toHaveBeenCalledOnce();
    expect(recentWrites.append).toHaveBeenCalledWith(
      profileId,
      reviewId,
      { _tag: "AssigneeChange", added: [], removed: ["octocat"] },
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("does not journal a failed write", async () => {
    const gate = makeGate();
    const addAssigneesToAssignable = vi.fn(async () => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "unavailable" as const,
        message: "x",
      },
    }));
    const recentWrites = makeRecentWrites();
    const service = new AssigneeService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addAssigneesToAssignable }) as never,
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

  it("refuses a write when permission is explicitly denied", async () => {
    const gate = makeGate();
    const addAssigneesToAssignable = vi.fn();
    const getRepositoryPermission = vi.fn(async () =>
      ok({
        account: "octocat",
        permission: "triage" as const,
        pullRequestsWrite: false,
        canManageLabels: true,
      }),
    );
    const service = new AssigneeService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({
        addAssigneesToAssignable,
        getRepositoryPermission,
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
    expect(addAssigneesToAssignable).not.toHaveBeenCalled();
  });

  it("refuses a write when permission is unknown, never treating unknown as permitted", async () => {
    const gate = makeGate();
    const addAssigneesToAssignable = vi.fn();
    // No `getRepositoryPermission` implementation at all is the adapter's
    // real-world "unknown" shape (an optional method the reader never wired up).
    const service = new AssigneeService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({
        addAssigneesToAssignable,
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
    expect(addAssigneesToAssignable).not.toHaveBeenCalled();
  });

  it("surfaces a forbidden assignee write as 'forbidden', not the generic 'github_write_failed'", async () => {
    const gate = makeGate();
    const addAssigneesToAssignable = vi.fn(async () => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "forbidden" as const,
        message: "blocked",
        reason: "saml" as const,
      },
    }));
    const service = new AssigneeService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addAssigneesToAssignable }) as never,
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

  it("rejects an empty assignee list before checking permission", async () => {
    const gate = makeGate();
    const service = new AssigneeService(
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
      command: command({ assignees: [] }),
    });
    expect(result).toEqual({ _tag: "err", error: "invalid_input" });
    expect(gate.requireCurrentSession).not.toHaveBeenCalled();
  });

  it("does not enter while another write owns the Review write coordinator", async () => {
    const gate = makeGate();
    const addAssigneesToAssignable = vi.fn(async () => ok(undefined));
    const coordinator = new ReviewOperationCoordinator();
    const key = `${profileId}:${reviewId}`;
    expect(coordinator.acquire(key)).toBe(true);
    const service = new AssigneeService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addAssigneesToAssignable }) as never,
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
    expect(addAssigneesToAssignable).not.toHaveBeenCalled();
    coordinator.release(key);
  });

  it("gates on the current session, not on patch freshness — a stale gate response still refuses the write", async () => {
    const gate = {
      requireCurrentSession: vi.fn(async () => ({
        _tag: "err" as const,
        error: { reason: "terminal" as const },
      })),
    };
    const addAssigneesToAssignable = vi.fn();
    const service = new AssigneeService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addAssigneesToAssignable }) as never,
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
    expect(addAssigneesToAssignable).not.toHaveBeenCalled();
  });

  describe("the ten-assignee cap", () => {
    it("refuses a write that would exceed the cap before ever calling GitHub", async () => {
      const gate = makeGate();
      const addAssigneesToAssignable = vi.fn();
      const existing = Array.from(
        { length: 10 },
        (_, index) => `user-${index}`,
      );
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ addAssigneesToAssignable }, existing) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.execute({
        profileId,
        reviewId,
        command: command({
          _tag: "AddAssignees",
          assignees: [{ id: "MDQ6VXNlcjE=", login: "eleventh" }],
        }),
      });
      expect(result).toEqual({ _tag: "err", error: "assignee_cap_exceeded" });
      expect(addAssigneesToAssignable).not.toHaveBeenCalled();
    });

    it("allows re-adding an already-assigned login without counting it twice against the cap", async () => {
      const gate = makeGate();
      const addAssigneesToAssignable = vi.fn(async () => ok(undefined));
      const existing = Array.from(
        { length: 10 },
        (_, index) => `user-${index}`,
      );
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ addAssigneesToAssignable }, existing) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.execute({
        profileId,
        reviewId,
        command: command({
          _tag: "AddAssignees",
          assignees: [{ id: "MDQ6VXNlcjE=", login: "user-0" }],
        }),
      });
      expect(result._tag).toBe("ok");
      expect(addAssigneesToAssignable).toHaveBeenCalledOnce();
    });

    it("does not apply the cap to a remove", async () => {
      const gate = makeGate();
      const removeAssigneesFromAssignable = vi.fn(async () => ok(undefined));
      const existing = Array.from(
        { length: 10 },
        (_, index) => `user-${index}`,
      );
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ removeAssigneesFromAssignable }, existing) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.execute({
        profileId,
        reviewId,
        command: command({
          _tag: "RemoveAssignees",
          assignees: [{ id: "MDQ6VXNlcjE=", login: "user-0" }],
        }),
      });
      expect(result._tag).toBe("ok");
      expect(removeAssigneesFromAssignable).toHaveBeenCalledOnce();
    });
  });

  describe("AssignSelf", () => {
    it("resolves the authenticated account and assigns it", async () => {
      const gate = makeGate();
      const addAssigneesToAssignable = vi.fn(async () => ok(undefined));
      const resolveAuthenticatedAccount = vi.fn(async () =>
        ok({ host: "github.com", account: "octocat" }),
      );
      const listAssignableUsers = vi.fn(async () =>
        ok({
          users: [
            { id: "MDQ6VXNlcjE=", login: "octocat" },
            { id: "MDQ6VXNlcjI=", login: "octocat-imposter" },
          ],
          totalCount: 2,
        }),
      );
      const recentWrites = makeRecentWrites();
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({
          addAssigneesToAssignable,
          resolveAuthenticatedAccount,
          listAssignableUsers,
        }) as never,
        new ReviewOperationCoordinator(),
        now,
        recentWrites,
      );
      const result = await service.execute({
        profileId,
        reviewId,
        command: { _tag: "AssignSelf" },
      });
      expect(result).toEqual({
        _tag: "ok",
        value: { _tag: "AssigneesAdded", added: ["octocat"] },
      });
      // Searches by the resolved login and requires an exact match, not just
      // GitHub's substring search's first result (`octocat-imposter` sorts
      // before `octocat` was not assumed).
      expect(listAssignableUsers).toHaveBeenCalledWith(
        expect.objectContaining({ query: "octocat" }),
      );
      expect(addAssigneesToAssignable).toHaveBeenCalledWith(
        expect.objectContaining({
          assignableId: "PR_node",
          assigneeIds: ["MDQ6VXNlcjE="],
        }),
      );
      expect(recentWrites.append).toHaveBeenCalledWith(
        profileId,
        reviewId,
        { _tag: "AssigneeChange", added: ["octocat"], removed: [] },
        "2026-01-01T00:00:00.000Z",
      );
    });

    it("refuses without 'permitted', the same as any other assignee write", async () => {
      const gate = makeGate();
      const addAssigneesToAssignable = vi.fn();
      const getRepositoryPermission = vi.fn(async () =>
        ok({
          account: "octocat",
          permission: "triage" as const,
          pullRequestsWrite: false,
          canManageLabels: true,
        }),
      );
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({
          addAssigneesToAssignable,
          getRepositoryPermission,
        }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.execute({
        profileId,
        reviewId,
        command: { _tag: "AssignSelf" },
      });
      expect(result).toEqual({ _tag: "err", error: "permission_denied" });
      expect(addAssigneesToAssignable).not.toHaveBeenCalled();
    });

    it("fails cleanly, not silently, when the authenticated account cannot be resolved", async () => {
      const gate = makeGate();
      const addAssigneesToAssignable = vi.fn();
      // `resolveAuthenticatedAccount` is called twice on this path — once by
      // the permission gate, once by self-identity resolution — so it
      // succeeds the first time (isolating this test to the second call
      // failing) and fails the second, e.g. a token invalidated mid-write.
      const resolveAuthenticatedAccount = vi
        .fn()
        .mockResolvedValueOnce(ok({ host: "github.com", account: "octocat" }))
        .mockResolvedValueOnce({
          _tag: "err" as const,
          error: {
            _tag: "GitHubAuthenticationFailed" as const,
            operation: "auth_status" as const,
          },
        });
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({
          addAssigneesToAssignable,
          resolveAuthenticatedAccount,
        }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.execute({
        profileId,
        reviewId,
        command: { _tag: "AssignSelf" },
      });
      expect(result).toEqual({ _tag: "err", error: "github_read_failed" });
      expect(addAssigneesToAssignable).not.toHaveBeenCalled();
    });

    it("fails cleanly, not silently, when the resolved account has no assignable node id", async () => {
      const gate = makeGate();
      const addAssigneesToAssignable = vi.fn();
      const listAssignableUsers = vi.fn(async () =>
        ok({ users: [], totalCount: 0 }),
      );
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({
          addAssigneesToAssignable,
          listAssignableUsers,
        }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.execute({
        profileId,
        reviewId,
        command: { _tag: "AssignSelf" },
      });
      expect(result).toEqual({ _tag: "err", error: "github_read_failed" });
      expect(addAssigneesToAssignable).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("reaches the renderer with the assignable users intact", async () => {
      const gate = makeGate();
      const listAssignableUsers = vi.fn(async () =>
        ok({
          users: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
          totalCount: 1,
        }),
      );
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listAssignableUsers }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({
        _tag: "ok",
        value: {
          _tag: "ready",
          users: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
          totalCount: 1,
          permission: "permitted",
        },
      });
      expect(listAssignableUsers).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: expect.objectContaining({
            owner: "centraldigital",
            repo: "patchdesk",
          }),
        }),
      );
    });

    it("carries 'denied' onto the read outcome instead of only discovering it via a rejected write", async () => {
      const gate = makeGate();
      const listAssignableUsers = vi.fn(async () =>
        ok({
          users: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
          totalCount: 1,
        }),
      );
      const getRepositoryPermission = vi.fn(async () =>
        ok({
          account: "octocat",
          permission: "triage" as const,
          pullRequestsWrite: false,
          canManageLabels: true,
        }),
      );
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listAssignableUsers, getRepositoryPermission }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({
        _tag: "ok",
        value: {
          _tag: "ready",
          users: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
          totalCount: 1,
          permission: "denied",
        },
      });
    });

    it("carries 'unknown' onto the read outcome when permission evidence is unavailable, never 'permitted'", async () => {
      const gate = makeGate();
      const listAssignableUsers = vi.fn(async () =>
        ok({
          users: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
          totalCount: 1,
        }),
      );
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({
          listAssignableUsers,
          // No `getRepositoryPermission` implementation is the adapter's
          // real-world "unknown" shape (an optional method left unwired).
          getRepositoryPermission: undefined as never,
        }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({
        _tag: "ok",
        value: {
          _tag: "ready",
          users: [{ id: "MDQ6VXNlcjE=", login: "octocat" }],
          totalCount: 1,
          permission: "unknown",
        },
      });
    });

    it("surfaces a forbidden read as its specific reason, not a generic failure", async () => {
      const gate = makeGate();
      const listAssignableUsers = vi.fn(async () => ({
        _tag: "err" as const,
        error: {
          _tag: "GitHubForbidden" as const,
          operation: "list_assignable_users" as const,
          reason: "saml" as const,
        },
      }));
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listAssignableUsers }) as never,
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

    it("surfaces a rate-limited read with its resume time, not a generic failure", async () => {
      const gate = makeGate();
      const resumeAt = "2026-01-01T01:00:00.000Z";
      const listAssignableUsers = vi.fn(async () => ({
        _tag: "err" as const,
        error: {
          _tag: "GitHubRateLimited" as const,
          operation: "list_assignable_users" as const,
          // SAFETY: this literal is a well-formed ISO 8601 instant,
          // satisfying the branded IsoTimestamp contract this field expects.
          resumeAt: resumeAt as never,
        },
      }));
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listAssignableUsers }) as never,
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

    it("refuses without listing when the review cannot be resolved", async () => {
      const gate = {
        requireCurrentSession: vi.fn(async () => ({
          _tag: "err" as const,
          error: { reason: "not_found" as const },
        })),
      };
      const listAssignableUsers = vi.fn();
      const service = new AssigneeService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listAssignableUsers }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({ _tag: "err", error: "not_found" });
      expect(listAssignableUsers).not.toHaveBeenCalled();
    });
  });
});
