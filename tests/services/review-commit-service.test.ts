import { describe, expect, it } from "vitest";
import { ReviewCommitService } from "../../src/services/review-commit-service";
import { createReview } from "../../src/domain/review";
import {
  createReviewSessionId,
  parseGitSha,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T =>
  result._tag === "ok"
    ? result.value
    : (() => {
        throw new Error("fixture");
      })();
const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("1".repeat(40)));
const baseSha = must(parseGitSha("0".repeat(40)));
const commitSha = must(parseGitSha("2".repeat(40)));
const at = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const identity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
const sessionId = createReviewSessionId({ ...identity, headSha, baseSha });
const review = {
  ...createReview({
    identity,
    currentSessionId: sessionId,
    headSha,
    createdAt: at,
  }),
  representedRemote: {
    headSha,
    pullRequestUpdatedAt: at,
    // SAFETY: This literal is a well-formed 64-character content-hash fixture.
    snapshotHash: "a".repeat(64) as never,
    refreshedAt: at,
  },
};
const snapshot = {
  schemaVersion: 1 as const,
  pullRequest: {
    ref: {
      host: identity.host,
      owner: identity.owner,
      repo: identity.repo,
      number: identity.prNumber,
    },
    headSha,
    isDraft: false,
    isOpen: true,
    title: "Fixture",
    author: "fixture",
    headBranch: "main",
    baseBranch: "sit",
    reviewState: "none" as const,
    mergeability: "mergeable" as const,
    labels: [],
    updatedAt: at,
  },
  comments: { threads: [], complete: true },
  commits: [
    {
      sha: commitSha,
      message: "Commit",
      author: "Author",
      authoredAt: at,
      isHead: false,
    },
  ],
  checks: { overall: "passing" as const, checks: [] },
};
const session = {
  id: sessionId,
  key: { ...identity, headSha, baseSha },
  // SAFETY: This test path is an absolute filesystem-path fixture; no filesystem value crosses the production boundary from this cast.
  worktree: { path: "/tmp/patchdesk-worktree" as never, headSha },
  pr: { headSha, baseSha, isDraft: false, isOpen: true },
};

describe("ReviewCommitService", () => {
  it("returns a bounded diff for a commit in the represented session", async () => {
    const calls: string[][] = [];
    const service = new ReviewCommitService(
      {
        async load() {
          return ok(review);
        },
      },
      {
        async load() {
          // SAFETY: This fake storage returns the complete snapshot fixture consumed by ReviewCommitService.
          return ok(snapshot as never);
        },
      },
      {
        async load() {
          // SAFETY: This fake storage returns the complete session fixture consumed by ReviewCommitService.
          return ok(session as never);
        },
      },
      {
        async run(argv) {
          calls.push([...argv]);
          return calls.length === 1
            ? ok({ stdout: `${headSha}\n` })
            : calls.length === 2
              ? ok({ stdout: "" })
              : ok({
                  stdout:
                    "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+change\n",
                });
        },
      },
    );
    await expect(
      service.diff({ profileId, reviewId: review.id, commitSha }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        commit: snapshot.commits[0],
        position: 1,
        total: 1,
        patch:
          "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+change\n",
        fileCount: 1,
        additions: 1,
        deletions: 1,
      },
    });
    expect(calls[0]).toContain(
      `refs/patchdesk/reviews/${profileId}/${sessionId}/head^{commit}`,
    );
  });

  it("rejects a commit that is not in the represented commit list", async () => {
    const service = new ReviewCommitService(
      {
        async load() {
          return ok(review);
        },
      },
      {
        async load() {
          // SAFETY: This fake storage returns the complete snapshot fixture consumed by ReviewCommitService.
          return ok(snapshot as never);
        },
      },
      {
        async load() {
          // SAFETY: This fake storage returns the complete session fixture consumed by ReviewCommitService.
          return ok(session as never);
        },
      },
      {
        async run() {
          throw new Error("git must not run");
        },
      },
    );
    await expect(
      service.diff({ profileId, reviewId: review.id, commitSha: headSha }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "foreign_commit" } });
  });
});
