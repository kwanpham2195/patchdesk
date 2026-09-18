import { describe, expect, it } from "vitest";

import {
  FakeGitHubAdapter,
  type FakeGitHubAdapterValues,
} from "../../src/adapters/github/fake-github-adapter";
import { BaseBranchService } from "../../src/services/base-branch-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { makeReviewWriteOperations } from "./pull-request-metadata-fixtures";
import { now, profileId, reviewId, values } from "./review-invariant-fixtures";
import { confirmedWriteJournal, freshGate } from "./write-invariant-harness";

const permitted = {
  account: "fixture",
  permission: "write",
  pullRequestsWrite: true,
  canManageLabels: true,
} as const;

function makeService(fixture: Partial<FakeGitHubAdapterValues>) {
  const github = new FakeGitHubAdapter({
    authenticatedAccount: { host: "github.com", account: "fixture" },
    pullRequest: { ...values.snapshot.pullRequest, nodeId: "PR_node" },
    repositoryPermission: permitted,
    setPullRequestBaseBranch: {},
    ...fixture,
  });
  const recentWrites = confirmedWriteJournal();
  const operations = makeReviewWriteOperations();
  const service = new BaseBranchService(
    freshGate({ current: () => values.session }),
    github,
    new ReviewOperationCoordinator(),
    now,
    recentWrites,
    operations,
  );
  return { service, github, recentWrites, operations };
}

const setBaseBranch = (branch: string) => ({
  profileId,
  reviewId,
  command: { _tag: "SetBaseBranch" as const, branch },
});

describe("BaseBranchService.execute", () => {
  it("moves the pull request onto the branch and journals the confirmed write", async () => {
    const { service, github, recentWrites } = makeService({});
    await expect(
      service.execute(setBaseBranch("release/1.2")),
    ).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "BaseBranchChanged", branch: "release/1.2" },
    });
    expect(github.calls.setPullRequestBaseBranch).toMatchObject([
      { pullRequestId: "PR_node", branch: "release/1.2" },
    ]);
    expect(recentWrites.appendConfirmed).toHaveBeenCalledWith(
      profileId,
      reviewId,
      { _tag: "BaseBranchChange", branch: "release/1.2" },
      values.at,
    );
  });

  it("refuses when permission evidence is unknown", async () => {
    // Evidence for another account is no evidence, so permission is unknown.
    const { service, github } = makeService({
      authenticatedAccount: { host: "github.com", account: "someone-else" },
    });
    await expect(
      service.execute(setBaseBranch("release/1.2")),
    ).resolves.toEqual({ _tag: "err", error: "permission_denied" });
    expect(github.calls.setPullRequestBaseBranch).toEqual([]);
  });

  it("refuses an account without pull-request write", async () => {
    const { service, github } = makeService({
      repositoryPermission: {
        ...permitted,
        permission: "read",
        pullRequestsWrite: false,
      },
    });
    await expect(
      service.execute(setBaseBranch("release/1.2")),
    ).resolves.toEqual({ _tag: "err", error: "permission_denied" });
    expect(github.calls.setPullRequestBaseBranch).toEqual([]);
  });

  it("refuses the branch the pull request already targets without spending a write", async () => {
    const { service, github, recentWrites } = makeService({});
    await expect(service.execute(setBaseBranch("sit"))).resolves.toEqual({
      _tag: "err",
      error: "invalid_input",
    });
    expect(github.calls.setPullRequestBaseBranch).toEqual([]);
    expect(recentWrites.appendConfirmed).not.toHaveBeenCalled();
  });

  it("keeps the write locked when GitHub's answer is lost", async () => {
    const { service, recentWrites, operations } = makeService({
      setPullRequestBaseBranch: {
        failure: {
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "timeout",
        },
      },
    });
    await expect(
      service.execute(setBaseBranch("release/1.2")),
    ).resolves.toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(recentWrites.appendConfirmed).not.toHaveBeenCalled();
    await expect(operations.load()).resolves.toMatchObject({
      value: { state: { _tag: "OutcomeUnknown" } },
    });
  });
});

describe("BaseBranchService.list", () => {
  it("returns the current base, the candidate branches, and the permission", async () => {
    const { service, github } = makeService({
      repositoryBranches: { branches: ["release/1.2", "sit"], totalCount: 2 },
    });
    await expect(
      service.list({ profileId, reviewId, query: "rel" }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        _tag: "ready",
        current: "sit",
        branches: ["release/1.2", "sit"],
        branchesTotalCount: 2,
        permission: "permitted",
      },
    });
    expect(github.calls.listRepositoryBranches).toMatchObject([
      { query: "rel" },
    ]);
  });

  it("reports a failed branch read as data", async () => {
    const { service } = makeService({});
    await expect(service.list({ profileId, reviewId })).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "github_read" },
    });
  });
});
