import { describe, expect, it, vi } from "vitest";

import { DraftStateService } from "../../src/services/draft-state-service";
import { ok, err } from "../../src/domain/result";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  makeGate,
  makeRecentWrites,
  makeReviewWriteOperations,
  now,
  profileId,
  reviewId,
} from "./pull-request-metadata-fixtures";

function makeGateway(
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
  pullRequest: { readonly nodeId?: string; readonly isDraft: boolean } = {
    nodeId: "PR_node",
    isDraft: true,
  },
) {
  return {
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
    // SAFETY: the service reads only `nodeId` and `isDraft` from this stub.
    getPullRequest: vi.fn(async () => ok(pullRequest as never)),
    setPullRequestDraftState: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
}

function makeService(github: ReturnType<typeof makeGateway>) {
  const recentWrites = makeRecentWrites();
  const service = new DraftStateService(
    makeGate(),
    // SAFETY: the mock implements exactly the Gateway methods this service
    // calls; nothing else is reachable from `execute`.
    github as never,
    new ReviewOperationCoordinator(),
    now,
    recentWrites,
    makeReviewWriteOperations(),
  );
  return { service, recentWrites };
}

describe("DraftStateService", () => {
  it("publishes a draft for review and journals the confirmed write", async () => {
    const github = makeGateway();
    const { service, recentWrites } = makeService(github);
    await expect(
      service.execute({
        profileId,
        reviewId,
        command: { _tag: "SetDraftState", draft: false },
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "DraftStateChanged", draft: false },
    });
    expect(github.setPullRequestDraftState).toHaveBeenCalledOnce();
    expect(github.setPullRequestDraftState).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestId: "PR_node", draft: false }),
    );
    expect(recentWrites.append).toHaveBeenCalledWith(
      profileId,
      reviewId,
      { _tag: "DraftStateChange", draft: false },
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("converts a published pull request back to draft", async () => {
    const github = makeGateway({}, { nodeId: "PR_node", isDraft: false });
    const { service } = makeService(github);
    await expect(
      service.execute({
        profileId,
        reviewId,
        command: { _tag: "SetDraftState", draft: true },
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "DraftStateChanged", draft: true },
    });
    expect(github.setPullRequestDraftState).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true }),
    );
  });

  it("refuses a toggle GitHub already answered, never crossing the write boundary", async () => {
    // The race the UI cannot prevent: someone else published the draft
    // between the read this workbench rendered and this command.
    const github = makeGateway({}, { nodeId: "PR_node", isDraft: false });
    const { service, recentWrites } = makeService(github);
    await expect(
      service.execute({
        profileId,
        reviewId,
        command: { _tag: "SetDraftState", draft: false },
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_input" });
    expect(github.setPullRequestDraftState).not.toHaveBeenCalled();
    expect(recentWrites.append).not.toHaveBeenCalled();
  });

  it("refuses without explicit pull-request-write permission", async () => {
    const github = makeGateway({
      getRepositoryPermission: vi.fn(async () =>
        ok({
          account: "octocat",
          permission: "read" as const,
          pullRequestsWrite: false,
          canManageLabels: false,
        }),
      ),
    });
    const { service } = makeService(github);
    await expect(
      service.execute({
        profileId,
        reviewId,
        command: { _tag: "SetDraftState", draft: false },
      }),
    ).resolves.toEqual({ _tag: "err", error: "permission_denied" });
    expect(github.setPullRequestDraftState).not.toHaveBeenCalled();
  });

  it("refuses when the read carries no pull request node id", async () => {
    const github = makeGateway({}, { isDraft: true });
    const { service } = makeService(github);
    await expect(
      service.execute({
        profileId,
        reviewId,
        command: { _tag: "SetDraftState", draft: false },
      }),
    ).resolves.toEqual({ _tag: "err", error: "github_read_failed" });
  });

  it("reports an unavailable mutation as an unknown outcome", async () => {
    const github = makeGateway({
      setPullRequestDraftState: vi.fn(async () =>
        err({
          _tag: "GitHubWriteFailure" as const,
          category: "unavailable" as const,
          message: "set_draft_state",
        }),
      ),
    });
    const { service, recentWrites } = makeService(github);
    await expect(
      service.execute({
        profileId,
        reviewId,
        command: { _tag: "SetDraftState", draft: false },
      }),
    ).resolves.toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(recentWrites.append).not.toHaveBeenCalled();
  });
});
