import { describe, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import type { MaintainerInboxCache } from "../../src/adapters/storage/maintainer-inbox-cache-store";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestSummary } from "../../src/domain/github-context";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { err, ok } from "../../src/domain/result";
import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";

function must<T, E>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err"; readonly error: E }): T {
  if (result._tag === "err") throw new Error("Expected parsed fixture");
  return result.value;
}

const profile = must(parseWorkspaceProfileConfig({
  id: "cfw",
  label: "CFW",
  githubHost: "github.com",
  ghAccount: "maintainer",
  ownerFilters: [],
  workspaceRoots: [],
  rulePaths: [],
  repos: [{ host: "github.com", owner: "centraldigital", repo: "patchdesk", localPath: "/workspace/patchdesk" }],
}));
const sha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
const now = must(parseIsoTimestamp("2026-07-18T00:00:00.000Z"));
const summary: PullRequestSummary = {
  ref: { host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), number: must(parsePullRequestNumber(42)) },
  title: "Guard duplicate input",
  author: "author",
  headBranch: "feature/guard",
  baseBranch: "sit",
  headSha: sha,
  isDraft: false,
  isOpen: true,
  reviewState: "none",
  mergeability: "mergeable",
  labels: [],
  requestedReviewers: ["maintainer"],
  updatedAt: now,
};

describe("maintainer inbox service", () => {
  it("projects fresh remote rows and surfaces current merge readiness", async () => {
    const github = new FakeGitHubAdapter({
      authenticatedAccount: { host: "github.com", account: "maintainer" },
      maintainerPullRequests: { pullRequests: [{ summary, checks: { overall: "passing", checks: [] } }], complete: true },
    });
    const sessionId = "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never;
    const service = new MaintainerInboxService(github, {
      async listSessions() {
        return ok([{
          id: sessionId,
          key: { profileId: profile.id, host: summary.ref.host, owner: summary.ref.owner, repo: summary.ref.repo, prNumber: summary.ref.number, headSha: sha },
          pr: { headSha: sha, isDraft: false, isOpen: true },
          patchPath: "/tmp/patch.diff" as never,
          scope: { kind: "full" },
          worktree: { path: "/tmp/worktree" as never, headSha: sha },
          state: { _tag: "ReviewCompleted", attemptId: "001" as never },
          draft: { state: { _tag: "LocalDraft" } },
          createdAt: now,
          updatedAt: now,
        schemaVersion: 4,
        }]);
      },
      async loadAttempt() { return err({ _tag: "StorageFailure", operation: "read", reason: "not_found" }); },
    }, {
      async read() { return err({ _tag: "StorageFailure", operation: "read", reason: "not_found" }); },
      async save() { return ok(undefined); },
    }, { now: () => now });

    const inbox = await service.list(profile);
    expect(inbox).toMatchObject({
      _tag: "ok",
      value: { dataFreshness: "fresh", snapshot: { state: "current" }, rows: [{ categories: ["needs_review", "ready_to_merge"], recommendedAction: { kind: "open_merge_readiness" } }] },
    });
  });

  it("never presents an incomplete repository snapshot as current", async () => {
    const github = new FakeGitHubAdapter({
      authenticatedAccount: { host: "github.com", account: "maintainer" },
      maintainerPullRequests: { pullRequests: [{ summary, checks: { overall: "passing", checks: [] } }], complete: false },
    });
    const service = new MaintainerInboxService(github, {
      async listSessions() { return ok([]); },
      async loadAttempt() { return err({ _tag: "StorageFailure", operation: "read", reason: "not_found" }); },
    }, {
      async read() { return err({ _tag: "StorageFailure", operation: "read", reason: "not_found" }); },
      async save() { return ok(undefined); },
    }, { now: () => now });

    const inbox = await service.list(profile);
    expect(inbox).toMatchObject({ _tag: "ok", value: { dataFreshness: "cached", snapshot: { state: "partial" } } });
  });

  it("returns cached rows with merge actions downgraded when authentication is unavailable", async () => {
    const cache: MaintainerInboxCache = {
      schemaVersion: 1,
      refreshedAt: now,
      rows: [{
        identity: summary.ref,
        title: summary.title,
        author: summary.author,
        baseBranch: summary.baseBranch,
        headBranch: summary.headBranch,
        currentHeadSha: sha,
        isDraft: false,
        updatedAt: now,
        changeStats: {},
        checks: { overall: "passing", checks: [] },
        reviewState: "approved",
        mergeability: "mergeable",
        categories: ["ready_to_merge"],
        recommendedAction: { kind: "open_merge_readiness", label: "Open merge readiness", sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never },
        dataFreshness: "fresh",
      }],
      repositories: [{ identity: { host: summary.ref.host, owner: summary.ref.owner, repo: summary.ref.repo }, state: "ready", complete: true }],
    };
    const service = new MaintainerInboxService(new FakeGitHubAdapter({}), {
      async listSessions() { return ok([]); },
      async loadAttempt() { return err({ _tag: "StorageFailure", operation: "read", reason: "not_found" }); },
    }, {
      async read() { return ok(cache); },
      async save() { return ok(undefined); },
    }, { now: () => now });
    const inbox = await service.list(profile);
    expect(inbox).toMatchObject({ _tag: "ok", value: { dataFreshness: "cached", snapshot: { state: "failed_cached" }, rows: [{ recommendedAction: { kind: "run_review" } }] } });
  });
});
