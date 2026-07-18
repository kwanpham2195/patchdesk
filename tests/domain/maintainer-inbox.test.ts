import { describe, expect, it } from "vitest";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewSessionId,
} from "../../src/domain/ids";
import { projectMaintainerInboxRow } from "../../src/domain/maintainer-inbox";

function must<T, E>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err"; readonly error: E }): T {
  if (result._tag === "err") throw new Error("Expected parsed fixture");
  return result.value;
}

const sha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
const sessionId = must(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab"));
const updatedAt = must(parseIsoTimestamp("2026-07-18T00:00:00.000Z"));
const summary = {
  ref: { host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), number: must(parsePullRequestNumber(42)) },
  headSha: sha,
  isDraft: false,
  isOpen: true,
  title: "Guard duplicate input",
  author: "author",
  headBranch: "feature/duplicate-guard",
  baseBranch: "sit",
  reviewState: "none" as const,
  mergeability: "mergeable" as const,
  labels: [],
  requestedReviewers: ["maintainer"],
  updatedAt,
  changedFileCount: 1,
  additions: 8,
  deletions: 2,
};
const passingChecks = { overall: "passing" as const, checks: [] };

describe("maintainer inbox", () => {
  it("prioritizes a running current-head review above every remote category", () => {
    const row = projectMaintainerInboxRow({
      summary,
      checks: passingChecks,
      activeAccount: "maintainer",
      latestReview: { sessionId, reviewedHeadSha: sha, state: "running", updatedAt, matchesCurrentHead: true },
      dataFreshness: "fresh",
    });
    expect(row.categories).toContain("running");
    expect(row.recommendedAction).toEqual({ kind: "continue_review", label: "Continue review", sessionId });
  });

  it("offers review updates for a completed prior head before an ordinary full review", () => {
    const priorSha = must(parseGitSha("bbbbbb1234567890abcdef1234567890abcdef12"));
    const row = projectMaintainerInboxRow({
      summary,
      checks: passingChecks,
      activeAccount: "maintainer",
      latestReview: { sessionId, reviewedHeadSha: priorSha, state: "completed", updatedAt, matchesCurrentHead: false },
      dataFreshness: "fresh",
    });
    expect(row.categories).toEqual(expect.arrayContaining(["needs_review", "updated_since_review"]));
    expect(row.recommendedAction).toEqual({ kind: "review_updates", label: "Review updates", baseSessionId: sessionId });
  });

  it("never exposes merge readiness as the primary action for cached metadata", () => {
    const row = projectMaintainerInboxRow({
      summary,
      checks: passingChecks,
      activeAccount: "someone-else",
      latestReview: { sessionId, reviewedHeadSha: sha, state: "completed", updatedAt, matchesCurrentHead: true },
      dataFreshness: "cached",
    });
    expect(row.categories).not.toContain("ready_to_merge");
    expect(row.recommendedAction).toEqual({ kind: "run_review", label: "Run review" });
  });
});
