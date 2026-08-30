import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssigneeService,
  type AssigneeCommand,
} from "../../src/services/assignee-service";
import {
  hashAvatarUrl,
  writeAvatar,
} from "../../src/adapters/storage/avatar-cache-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ok } from "../../src/domain/result";
import { AvatarSyncService } from "../../src/services/avatar-sync-service";

// The avatar fan-out cap is written out here rather than imported from the
// service, so this test pins the cap instead of restating whatever the
// implementation happens to hold.
const MAX_AVATARS_PER_SYNC = 24;

import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

// Real temp `PatchdeskPaths`, mirroring `avatar-cache-store.test.ts` and
// `avatar-sync-service.test.ts`: avatar resolution reads real bytes off
// disk, so a mock store would not exercise the real read path.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function avatarPaths(): Promise<PatchdeskPaths> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-assignee-avatar-"));
  roots.push(root);
  return PatchdeskPaths.forTest(root);
}

import {
  makeGate,
  makeRecentWrites,
  makeReviewWriteOperations,
  now,
  profileId,
  reviewId,
} from "./pull-request-metadata-fixtures";

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
      makeReviewWriteOperations(),
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
      makeReviewWriteOperations(),
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
      makeReviewWriteOperations(),
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command(),
    });
    expect(result).toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(addAssigneesToAssignable).toHaveBeenCalledOnce();
    await expect(
      service.execute({ profileId, reviewId, command: command() }),
    ).resolves.toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(addAssigneesToAssignable).toHaveBeenCalledOnce();
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
      makeReviewWriteOperations(),
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
      makeReviewWriteOperations(),
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
      makeReviewWriteOperations(),
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
      makeReviewWriteOperations(),
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
      makeReviewWriteOperations(),
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
      makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
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
        makeReviewWriteOperations(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({ _tag: "err", error: "not_found" });
      expect(listAssignableUsers).not.toHaveBeenCalled();
    });

    describe("avatars", () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);

      it("resolves a cached avatar to a data URI, and leaves an uncached one absent from the outcome", async () => {
        const store = await avatarPaths();
        const cachedUrl = "https://avatars.githubusercontent.com/u/501?v=1";
        const uncachedUrl = "https://avatars.githubusercontent.com/u/502?v=1";
        await writeAvatar(store, profileId, hashAvatarUrl(cachedUrl), bytes);
        const gate = makeGate();
        const listAssignableUsers = vi.fn(async () =>
          ok({
            users: [
              { id: "U1", login: "cached-user", avatarUrl: cachedUrl },
              { id: "U2", login: "uncached-user", avatarUrl: uncachedUrl },
            ],
            totalCount: 2,
          }),
        );
        const warmAvatarUrls = vi.fn(async () => undefined);
        const service = new AssigneeService(
          gate,
          // SAFETY: the mock only implements the Gateway methods this test
          // exercises; the service never calls any method left unimplemented.
          makeGateway({ listAssignableUsers }) as never,
          new ReviewOperationCoordinator(),
          now,
          makeRecentWrites(),
          makeReviewWriteOperations(),
          { paths: store, sync: { warmAvatarUrls } },
        );
        const result = await service.list({ profileId, reviewId });
        if (result._tag !== "ok" || result.value._tag !== "ready")
          throw new Error("fixture");
        const cached = result.value.users.find(
          (user) => user.login === "cached-user",
        );
        const uncached = result.value.users.find(
          (user) => user.login === "uncached-user",
        );
        expect(cached?.avatarDataUri).toMatch(/^data:/);
        expect(uncached?.avatarDataUri).toBeUndefined();
        expect(warmAvatarUrls).toHaveBeenCalledWith({
          profileId,
          avatarUrls: [cachedUrl, uncachedUrl],
        });
      });

      it("never fails the read when the avatar dependency itself throws", async () => {
        const store = await avatarPaths();
        const gate = makeGate();
        const listAssignableUsers = vi.fn(async () =>
          ok({
            users: [
              {
                id: "U1",
                login: "some-user",
                avatarUrl: "https://avatars.githubusercontent.com/u/1?v=1",
              },
            ],
            totalCount: 1,
          }),
        );
        const warmAvatarUrls = vi.fn(async () => {
          throw new Error("misbehaving dependency");
        });
        const service = new AssigneeService(
          gate,
          // SAFETY: the mock only implements the Gateway methods this test
          // exercises; the service never calls any method left unimplemented.
          makeGateway({ listAssignableUsers }) as never,
          new ReviewOperationCoordinator(),
          now,
          makeRecentWrites(),
          makeReviewWriteOperations(),
          { paths: store, sync: { warmAvatarUrls } },
        );
        const result = await service.list({ profileId, reviewId });
        if (result._tag !== "ok" || result.value._tag !== "ready")
          throw new Error("fixture");
        expect(result.value.users).toEqual([
          {
            id: "U1",
            login: "some-user",
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=1",
          },
        ]);
      });

      it("prioritises a currently-assigned person over other candidates when the warm cap bites", async () => {
        const store = await avatarPaths();
        const gate = makeGate();
        // `MAX_AVATARS_PER_SYNC` unassigned candidates, plus one assigned
        // person appended last -- without prioritization the assigned
        // person's avatar would be the one dropped by the cap.
        const unassigned = Array.from(
          { length: MAX_AVATARS_PER_SYNC },
          (_, index) => ({
            id: `U${index}`,
            login: `candidate-${index}`,
            avatarUrl: `https://avatars.githubusercontent.com/u/${index}?v=1`,
          }),
        );
        const assigned = {
          id: "U_assigned",
          login: "assigned-user",
          avatarUrl: "https://avatars.githubusercontent.com/u/assigned?v=1",
        };
        const listAssignableUsers = vi.fn(async () =>
          ok({
            users: [...unassigned, assigned],
            totalCount: unassigned.length + 1,
          }),
        );
        const fetchAvatar = vi.fn(async () => ({ bytes }));
        const sync = new AvatarSyncService({ paths: store, fetchAvatar });
        const service = new AssigneeService(
          gate,
          // SAFETY: the mock only implements the Gateway methods this test
          // exercises; `getPullRequest` reports `assigned-user` as the sole
          // current assignee.
          makeGateway({ listAssignableUsers }, ["assigned-user"]) as never,
          new ReviewOperationCoordinator(),
          now,
          makeRecentWrites(),
          makeReviewWriteOperations(),
          { paths: store, sync },
        );
        const result = await service.list({ profileId, reviewId });
        if (result._tag !== "ok" || result.value._tag !== "ready")
          throw new Error("fixture");
        const byLogin = new Map(
          result.value.users.map((user) => [user.login, user] as const),
        );
        // The assigned person's avatar was warmed despite starting last.
        expect(byLogin.get("assigned-user")?.avatarDataUri).toMatch(/^data:/);
        // Exactly one unassigned candidate was crowded out by the cap: the
        // one that would have been last after the assigned person moved to
        // the front of the warm order.
        const lastUnassigned = unassigned[unassigned.length - 1];
        if (lastUnassigned === undefined) throw new Error("fixture");
        expect(
          byLogin.get(lastUnassigned.login)?.avatarDataUri,
        ).toBeUndefined();
        expect(fetchAvatar).toHaveBeenCalledTimes(MAX_AVATARS_PER_SYNC);
      });
    });
  });
});
