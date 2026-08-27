import { describe, expect, it, vi } from "vitest";

import {
  LabelService,
  type LabelCommand,
} from "../../src/services/label-service";
import { ok } from "../../src/domain/result";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

import {
  makeGate,
  makeRecentWrites,
  now,
  profileId,
  reviewId,
} from "./pull-request-metadata-fixtures";

function command(overrides: Partial<LabelCommand> = {}): LabelCommand {
  // SAFETY: `overrides` can switch `_tag` to any LabelCommand variant; each
  // call site only sets the fields that variant requires, and the resulting
  // command is exercised (not just constructed) by the test.
  return {
    _tag: "AddLabels",
    labels: [{ id: "LA_bug", name: "bug" }],
    ...overrides,
  } as LabelCommand;
}

function makeGateway(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const github = {
    resolveAuthenticatedAccount: vi.fn(async () =>
      ok({ host: "github.com", account: "octocat" }),
    ),
    getRepositoryPermission: vi.fn(async () =>
      ok({
        account: "octocat",
        permission: "triage" as const,
        pullRequestsWrite: false,
        canManageLabels: true,
      }),
    ),
    // SAFETY: the service only reads `nodeId` from this stub.
    getPullRequest: vi.fn(async () => ok({ nodeId: "PR_node" } as never)),
    addLabelsToLabelable: vi.fn(async () => ok(undefined)),
    removeLabelsFromLabelable: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
  return github;
}

describe("LabelService", () => {
  it("adds labels and journals the confirmed write", async () => {
    const gate = makeGate();
    const addLabelsToLabelable = vi.fn(async () => ok(undefined));
    const recentWrites = makeRecentWrites();
    const service = new LabelService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addLabelsToLabelable }) as never,
      new ReviewOperationCoordinator(),
      now,
      recentWrites,
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "AddLabels",
        labels: [{ id: "LA_bug", name: "bug" }],
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: { _tag: "LabelsAdded", added: ["bug"] },
    });
    expect(addLabelsToLabelable).toHaveBeenCalledOnce();
    expect(addLabelsToLabelable).toHaveBeenCalledWith(
      expect.objectContaining({ labelableId: "PR_node", labelIds: ["LA_bug"] }),
    );
    expect(recentWrites.append).toHaveBeenCalledOnce();
    expect(recentWrites.append).toHaveBeenCalledWith(
      profileId,
      reviewId,
      { _tag: "LabelChange", added: ["bug"], removed: [] },
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("removes labels and journals the confirmed write", async () => {
    const gate = makeGate();
    const removeLabelsFromLabelable = vi.fn(async () => ok(undefined));
    const recentWrites = makeRecentWrites();
    const service = new LabelService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ removeLabelsFromLabelable }) as never,
      new ReviewOperationCoordinator(),
      now,
      recentWrites,
    );
    const result = await service.execute({
      profileId,
      reviewId,
      command: command({
        _tag: "RemoveLabels",
        labels: [{ id: "LA_bug", name: "bug" }],
      }),
    });
    expect(result).toEqual({
      _tag: "ok",
      value: { _tag: "LabelsRemoved", removed: ["bug"] },
    });
    expect(removeLabelsFromLabelable).toHaveBeenCalledOnce();
    expect(recentWrites.append).toHaveBeenCalledOnce();
    expect(recentWrites.append).toHaveBeenCalledWith(
      profileId,
      reviewId,
      { _tag: "LabelChange", added: [], removed: ["bug"] },
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("does not journal a failed write", async () => {
    const gate = makeGate();
    const addLabelsToLabelable = vi.fn(async () => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "unavailable" as const,
        message: "x",
      },
    }));
    const recentWrites = makeRecentWrites();
    const service = new LabelService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addLabelsToLabelable }) as never,
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
    const addLabelsToLabelable = vi.fn();
    const getRepositoryPermission = vi.fn(async () =>
      ok({
        account: "octocat",
        permission: "read" as const,
        pullRequestsWrite: false,
        canManageLabels: false,
      }),
    );
    const service = new LabelService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addLabelsToLabelable, getRepositoryPermission }) as never,
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
    expect(addLabelsToLabelable).not.toHaveBeenCalled();
  });

  it("refuses a write when permission is unknown, never treating unknown as permitted", async () => {
    const gate = makeGate();
    const addLabelsToLabelable = vi.fn();
    // No `getRepositoryPermission` implementation at all is the adapter's
    // real-world "unknown" shape (an optional method the reader never wired up).
    const service = new LabelService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({
        addLabelsToLabelable,
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
    expect(addLabelsToLabelable).not.toHaveBeenCalled();
  });

  it("surfaces a forbidden label write as 'forbidden', not the generic 'github_write_failed'", async () => {
    const gate = makeGate();
    const addLabelsToLabelable = vi.fn(async () => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "forbidden" as const,
        message: "blocked",
        reason: "saml" as const,
      },
    }));
    const service = new LabelService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addLabelsToLabelable }) as never,
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

  it("rejects an empty label list before checking permission", async () => {
    const gate = makeGate();
    const service = new LabelService(
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
      command: command({ labels: [] }),
    });
    expect(result).toEqual({ _tag: "err", error: "invalid_input" });
    expect(gate.requireCurrentSession).not.toHaveBeenCalled();
  });

  it("does not enter while another write owns the Review write coordinator", async () => {
    const gate = makeGate();
    const addLabelsToLabelable = vi.fn(async () => ok(undefined));
    const coordinator = new ReviewOperationCoordinator();
    const key = `${profileId}:${reviewId}`;
    expect(coordinator.acquire(key)).toBe(true);
    const service = new LabelService(
      gate,
      // SAFETY: the mock only implements the Gateway methods this test
      // exercises; the service never calls any method left unimplemented.
      makeGateway({ addLabelsToLabelable }) as never,
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
    expect(addLabelsToLabelable).not.toHaveBeenCalled();
    coordinator.release(key);
  });

  describe("list", () => {
    it("reaches the renderer with the repository's labels intact", async () => {
      const gate = makeGate();
      const listRepositoryLabels = vi.fn(async () =>
        ok({
          labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
          totalCount: 1,
        }),
      );
      const service = new LabelService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listRepositoryLabels }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({
        _tag: "ok",
        value: {
          _tag: "ready",
          labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
          totalCount: 1,
          permission: "permitted",
        },
      });
      expect(listRepositoryLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: expect.objectContaining({
            owner: "centraldigital",
            repo: "patchdesk",
          }),
        }),
      );
    });

    it("conveys truncation instead of silently dropping it", async () => {
      const gate = makeGate();
      const listRepositoryLabels = vi.fn(async () =>
        ok({
          labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
          totalCount: 150,
        }),
      );
      const service = new LabelService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listRepositoryLabels }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({
        _tag: "ok",
        value: {
          _tag: "ready",
          labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
          totalCount: 150,
          permission: "permitted",
        },
      });
    });

    it("carries 'denied' onto the read outcome instead of only discovering it via a rejected write", async () => {
      const gate = makeGate();
      const listRepositoryLabels = vi.fn(async () =>
        ok({
          labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
          totalCount: 1,
        }),
      );
      const getRepositoryPermission = vi.fn(async () =>
        ok({
          account: "octocat",
          permission: "read" as const,
          pullRequestsWrite: false,
          canManageLabels: false,
        }),
      );
      const service = new LabelService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listRepositoryLabels, getRepositoryPermission }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({
        _tag: "ok",
        value: {
          _tag: "ready",
          labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
          totalCount: 1,
          permission: "denied",
        },
      });
    });

    it("carries 'unknown' onto the read outcome when permission evidence is unavailable, never 'permitted'", async () => {
      const gate = makeGate();
      const listRepositoryLabels = vi.fn(async () =>
        ok({
          labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
          totalCount: 1,
        }),
      );
      const service = new LabelService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({
          listRepositoryLabels,
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
          labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
          totalCount: 1,
          permission: "unknown",
        },
      });
    });

    it("surfaces a forbidden read as its specific reason, not a generic failure", async () => {
      const gate = makeGate();
      const listRepositoryLabels = vi.fn(async () => ({
        _tag: "err" as const,
        error: {
          _tag: "GitHubForbidden" as const,
          operation: "list_repository_labels" as const,
          reason: "saml" as const,
        },
      }));
      const service = new LabelService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listRepositoryLabels }) as never,
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
      const listRepositoryLabels = vi.fn(async () => ({
        _tag: "err" as const,
        error: {
          _tag: "GitHubRateLimited" as const,
          operation: "list_repository_labels" as const,
          // SAFETY: this literal is a well-formed ISO 8601 instant,
          // satisfying the branded IsoTimestamp contract this field expects.
          resumeAt: resumeAt as never,
        },
      }));
      const service = new LabelService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listRepositoryLabels }) as never,
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
      const listRepositoryLabels = vi.fn();
      const service = new LabelService(
        gate,
        // SAFETY: the mock only implements the Gateway methods this test
        // exercises; the service never calls any method left unimplemented.
        makeGateway({ listRepositoryLabels }) as never,
        new ReviewOperationCoordinator(),
        now,
        makeRecentWrites(),
      );
      const result = await service.list({ profileId, reviewId });
      expect(result).toEqual({ _tag: "err", error: "not_found" });
      expect(listRepositoryLabels).not.toHaveBeenCalled();
    });
  });
});
