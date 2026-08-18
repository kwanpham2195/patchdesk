import { describe, expect, it, vi } from "vitest";

import { LabelService, type LabelCommand } from "../../src/services/label-service";
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
      error: { _tag: "GitHubWriteFailure" as const, category: "unavailable" as const, message: "x" },
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
});
