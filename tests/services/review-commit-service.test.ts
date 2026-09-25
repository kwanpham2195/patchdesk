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
const profileId = must(parseWorkspaceProfileId("acme"));
const headSha = must(parseGitSha("1".repeat(40)));
const baseSha = must(parseGitSha("0".repeat(40)));
const commitSha = must(parseGitSha("2".repeat(40)));
const at = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const identity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo-org")),
  repo: must(parseGitHubRepoName("patchdesk")),
  source: {
    kind: "pull_request" as const,
    prNumber: must(parsePullRequestNumber(42)),
  },
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
      number: identity.source.prNumber,
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
const profiles = {
  async load() {
    // SAFETY: the service reads only `ghAccount` from the profile.
    return ok({ ghAccount: "Viewer" } as never);
  },
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
      profiles,
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
      profiles,
    );
    await expect(
      service.diff({ profileId, reviewId: review.id, commitSha: headSha }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "foreign_commit" } });
  });

  /**
   * The condition ahead of `sessionRepresentsReview` here compares session
   * ids only. Nothing else in `diff` re-checks that the loaded Session names
   * the same pull request or the same head as the Review: the git commands
   * that follow run inside `session.worktree.path` and read
   * `session.key.headSha`, so a Session that agrees on id but not on revision
   * would have this service serve a diff out of the wrong checkout.
   */
  it("refuses a Session whose revision the Review no longer represents", async () => {
    const staleSessions = [
      { ...session, key: { ...session.key, headSha: commitSha } },
      // SAFETY: a plain owner string already satisfies GitHubOwner's runtime shape.
      { ...session, key: { ...session.key, owner: "someone-else" as never } },
    ];
    for (const stale of staleSessions) {
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
            return ok(stale as never);
          },
        },
        {
          async run() {
            throw new Error("git must not run for a stale session");
          },
        },
        profiles,
      );
      await expect(
        service.diff({ profileId, reviewId: review.id, commitSha }),
      ).resolves.toEqual({ _tag: "err", error: { reason: "stale_head" } });
    }
  });
});

const reviewedSha = must(parseGitSha("3".repeat(40)));
const laterReviewedSha = must(parseGitSha("4".repeat(40)));
const pullRequestCommits = [reviewedSha, laterReviewedSha, commitSha].map(
  (sha) => ({
    sha,
    message: "Commit",
    author: "Author",
    authoredAt: at,
    isHead: false,
  }),
);
const reviewSummary = (
  author: string,
  submittedAt: string,
  commitId: string,
) => ({
  _tag: "ReviewSummary" as const,
  review: {
    id: `${author}-${submittedAt}`,
    author,
    body: "",
    event: "COMMENTED" as const,
    submittedAt: must(parseIsoTimestamp(submittedAt)),
    canDismiss: false,
    commitId: must(parseGitSha(commitId)),
  },
});
const sincePatch =
  "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-reviewed\n+pushed later\n";

/** Runs `diffSinceReview` over a snapshot holding `entries`, recording every git argv. */
async function diffSinceReview(
  entries: ReadonlyArray<ReturnType<typeof reviewSummary>>,
) {
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
        return ok({
          ...snapshot,
          commits: pullRequestCommits,
          conversation: { prDescription: "", entries },
        } as never);
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
        if (argv.includes("rev-parse")) return ok({ stdout: `${headSha}\n` });
        if (argv.includes("diff")) return ok({ stdout: sincePatch });
        return ok({ stdout: "" });
      },
    },
    profiles,
  );
  const result = await service.diffSinceReview({
    profileId,
    reviewId: review.id,
  });
  return { result, diffCall: calls.find((argv) => argv.includes("diff")) };
}

describe("ReviewCommitService.diffSinceReview", () => {
  const headRef = `refs/patchdesk/reviews/${profileId}/${sessionId}/head`;

  it("refuses when the viewer has submitted no review", async () => {
    const { result, diffCall } = await diffSinceReview([
      reviewSummary("someone-else", "2026-08-02T00:00:00.000Z", reviewedSha),
    ]);
    expect(result).toEqual({ _tag: "err", error: { reason: "no_review" } });
    expect(diffCall).toBeUndefined();
  });

  it("diffs the head against the commit of the viewer's one review", async () => {
    const { result, diffCall } = await diffSinceReview([
      reviewSummary("viewer", "2026-08-02T00:00:00.000Z", reviewedSha),
    ]);
    expect(result).toEqual({
      _tag: "ok",
      value: { baseSha: reviewedSha, headSha, patch: sincePatch },
    });
    expect(diffCall?.slice(-2)).toEqual([reviewedSha, headRef]);
  });

  it("uses the viewer's latest review and ignores a later review by someone else", async () => {
    const { result, diffCall } = await diffSinceReview([
      reviewSummary("Viewer", "2026-08-03T00:00:00.000Z", laterReviewedSha),
      reviewSummary("viewer", "2026-08-02T00:00:00.000Z", reviewedSha),
      reviewSummary("someone-else", "2026-08-04T00:00:00.000Z", commitSha),
    ]);
    expect(result._tag === "ok" && result.value.baseSha).toBe(laterReviewedSha);
    expect(diffCall?.slice(-2)).toEqual([laterReviewedSha, headRef]);
  });

  it("refuses a reviewed commit that a force-push removed from the pull request", async () => {
    const { result, diffCall } = await diffSinceReview([
      reviewSummary("viewer", "2026-08-02T00:00:00.000Z", "5".repeat(40)),
    ]);
    expect(result).toEqual({
      _tag: "err",
      error: { reason: "unreachable_review" },
    });
    expect(diffCall).toBeUndefined();
  });
});
