import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  ReviewRemoteStore,
  hashSnapshot,
  parseReviewRemoteSnapshot,
  type ReviewRemoteSnapshot,
} from "../../src/adapters/storage/review-remote-store";
import { createReviewId } from "../../src/domain/ids";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  parseGitSha,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T =>
  result._tag === "ok"
    ? result.value
    : (() => {
        throw new Error("fixture");
      })();
const profileId = must(parseWorkspaceProfileId("cfw"));
const identity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
const headSha = must(parseGitSha("1".repeat(40)));
const reviewId = createReviewId(identity);
const roots: string[] = [];
const snapshot: ReviewRemoteSnapshot = {
  schemaVersion: 1,
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
    reviewState: "none",
    mergeability: "mergeable",
    labels: [],
    // SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
    updatedAt: "2026-08-01T00:00:00.000Z" as never,
  },
  comments: { threads: [], complete: true },
  commits: [],
  checks: {
    overall: "passing",
    checks: [
      {
        name: "build",
        required: true,
        status: "completed",
        conclusion: "success",
        url: "https://checks/one",
      },
    ],
  },
  conversation: { prDescription: "", entries: [] },
  mergeEvidence: {
    mergeable: "blocked",
    mergeStateStatus: "blocked",
    reviewDecision: "review_required",
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReviewRemoteStore", () => {
  it("round-trips a pull request with non-empty name+color labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const withLabels: ReviewRemoteSnapshot = {
      ...snapshot,
      pullRequest: {
        ...snapshot.pullRequest,
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "enhancement", color: "a2eeef" },
        ],
      },
    };
    const saved = await store.saveCandidate({
      profileId,
      reviewId,
      snapshot: withLabels,
    });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: withLabels });
  });

  it("round-trips the pull request's GraphQL nodeId", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const withNodeId: ReviewRemoteSnapshot = {
      ...snapshot,
      pullRequest: {
        ...snapshot.pullRequest,
        nodeId: "PR_kwDOOxMYd87hgCZR",
      },
    };
    const saved = await store.saveCandidate({
      profileId,
      reviewId,
      snapshot: withNodeId,
    });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: withNodeId });
  });

  it("round-trips viewerDidAuthor on thread comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const withComment: ReviewRemoteSnapshot = {
      ...snapshot,
      comments: {
        threads: [
          {
            // SAFETY: a test-only opaque thread id string; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
            id: "t" as never,
            state: "open" as const,
            comments: [
              {
                id: "c",
                author: "pmquan2",
                body: "test",
                // SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
                createdAt: "2026-08-01T00:05:00.000Z" as never,
                viewerDidAuthor: true,
                location: {
                  // SAFETY: a plain repo-relative path string already satisfies RepoRelativePath's runtime shape; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
                  path: "a.go" as never,
                  line: 1,
                  lineEnd: 1,
                  diffSide: "new" as const,
                },
              },
            ],
          },
        ],
        complete: true,
      },
    };
    const saved = await store.saveCandidate({
      profileId,
      reviewId,
      snapshot: withComment,
    });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: withComment });
  });

  it("round-trips authorAvatarUrl on thread comments, and still accepts a sibling comment without it", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const withAvatar: ReviewRemoteSnapshot = {
      ...snapshot,
      comments: {
        threads: [
          {
            // SAFETY: a test-only opaque thread id string; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
            id: "t" as never,
            state: "open" as const,
            comments: [
              {
                id: "c1",
                author: "pmquan2",
                authorAvatarUrl: "https://avatars.githubusercontent.com/u/1",
                body: "has an avatar",
                // SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
                createdAt: "2026-08-01T00:05:00.000Z" as never,
              },
              {
                // A comment from a deleted account carries no author object at
                // all, so `authorAvatarUrl` must stay representable as absent
                // — this sibling proves an existing snapshot without the
                // field still validates under the same (optional) schema.
                id: "c2",
                author: "ghost",
                body: "no avatar",
                // SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
                createdAt: "2026-08-01T00:06:00.000Z" as never,
              },
            ],
          },
        ],
        complete: true,
      },
    };
    const saved = await store.saveCandidate({
      profileId,
      reviewId,
      snapshot: withAvatar,
    });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: withAvatar });
  });

  it("accepts conversation ReviewComment entries with review-attached nodeId", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const withNodeId: ReviewRemoteSnapshot = {
      ...snapshot,
      conversation: {
        prDescription: "",
        entries: [
          {
            _tag: "ReviewComment" as const,
            comment: {
              id: "3783272017",
              nodeId: "PRRC_kwDOOxMYd87hgCZR",
              reviewId: "4936696628",
              author: "chanakan-art",
              body: "inline finding",
              // SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
              createdAt: "2026-08-14T11:26:55.000Z" as never,
              viewerDidAuthor: false,
              canEdit: false,
              canDelete: false,
              location: {
                // SAFETY: a plain repo-relative path string already satisfies RepoRelativePath's runtime shape; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
                path: "migrations/29.up.sql" as never,
                line: 44,
                diffSide: "new" as const,
              },
            },
          },
        ],
        complete: true,
      },
    };
    const parsed = parseReviewRemoteSnapshot(withNodeId);
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "err") return;
    const saved = await store.saveCandidate({
      profileId,
      reviewId,
      snapshot: withNodeId,
    });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: withNodeId });
  });

  it("round-trips a conversation IssueComment entry and rejects a diff-anchored one", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const comment = {
      id: "3783272018",
      nodeId: "IC_kwDOOxMYd87hgCZR",
      author: "kwanpham2195",
      body: "plain conversation comment",
      // SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape; the brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
      createdAt: "2026-08-14T11:26:55.000Z" as never,
      canEdit: true,
      canDelete: true,
    };
    const withIssueComment: ReviewRemoteSnapshot = {
      ...snapshot,
      conversation: {
        prDescription: "",
        entries: [{ _tag: "IssueComment" as const, comment }],
        complete: true,
      },
    };
    const saved = await store.saveCandidate({
      profileId,
      reviewId,
      snapshot: withIssueComment,
    });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: withIssueComment });
    // A stale snapshot that stamped a diff-anchored comment as an issue
    // comment fails closed rather than being re-read under the new meaning.
    expect(
      parseReviewRemoteSnapshot({
        ...withIssueComment,
        conversation: {
          ...withIssueComment.conversation,
          entries: [
            {
              _tag: "IssueComment",
              comment: { ...comment, location: { path: "src/a.ts", line: 4 } },
            },
          ],
        },
      })._tag,
    ).toBe("err");
  });

  it("writes and loads a strict content-addressed snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const saved = await store.saveCandidate({ profileId, reviewId, snapshot });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: snapshot });
    const changedUrl: ReviewRemoteSnapshot = {
      ...snapshot,
      checks: {
        ...snapshot.checks,
        checks: [
          {
            name: "build",
            required: true,
            status: "completed",
            conclusion: "success",
            url: "https://checks/two",
          },
        ],
      },
    };
    expect(hashSnapshot(snapshot)).toBe(hashSnapshot(changedUrl));
    const changedEvidence: ReviewRemoteSnapshot = {
      ...snapshot,
      mergeEvidence: {
        mergeable: "blocked",
        mergeStateStatus: "behind",
        reviewDecision: "review_required",
      },
    };
    expect(hashSnapshot(snapshot)).not.toBe(hashSnapshot(changedEvidence));
  });

  it("round-trips partial policy evidence and includes it in the snapshot hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const withPartialPolicy: ReviewRemoteSnapshot = {
      ...snapshot,
      mergeEvidence: {
        mergeable: "blocked",
        mergeStateStatus: "blocked",
        reviewDecision: "review_required",
        policy: {
          branchProtection: {
            state: "available",
            value: {
              requiredApprovingReviewCount: 2,
              dismissStaleReviews: true,
            },
          },
          appliedRuleset: { state: "unavailable", reason: "forbidden" },
        },
      },
    };
    const saved = await store.saveCandidate({
      profileId,
      reviewId,
      snapshot: withPartialPolicy,
    });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: withPartialPolicy });
    expect(saved.value.snapshotHash).not.toBe(hashSnapshot(snapshot));
  });

  it("round-trips applied-ruleset rule parameters", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const withRuleParameters: ReviewRemoteSnapshot = {
      ...snapshot,
      mergeEvidence: {
        mergeable: "blocked",
        mergeStateStatus: "blocked",
        reviewDecision: "review_required",
        policy: {
          branchProtection: { state: "unavailable", reason: "not_found" },
          appliedRuleset: {
            state: "available",
            value: {
              rules: [
                {
                  type: "pull_request",
                  name: "Protect sit",
                  pullRequestParameters: {
                    requiredApprovingReviewCount: 1,
                    requireLastPushApproval: true,
                    requiredReviewThreadResolution: true,
                    dismissStaleReviewsOnPush: false,
                    requireCodeOwnerReview: false,
                  },
                },
                {
                  type: "required_status_checks",
                  requiredStatusCheckContexts: [
                    "buildkite/dynamic-onboarding-service",
                  ],
                },
              ],
            },
          },
        },
      },
    };
    const saved = await store.saveCandidate({
      profileId,
      reviewId,
      snapshot: withRuleParameters,
    });
    expect(saved._tag).toBe("ok");
    if (saved._tag === "err") return;
    await expect(
      store.load({
        profileId,
        reviewId,
        snapshotHash: saved.value.snapshotHash,
      }),
    ).resolves.toEqual({ _tag: "ok", value: withRuleParameters });
  });

  it("accepts legacy snapshots without evidence and rejects untyped evidence", () => {
    const legacy = { ...snapshot, mergeEvidence: undefined };
    const parsedLegacy = parseReviewRemoteSnapshot(legacy);
    expect(parsedLegacy).toMatchObject({ _tag: "ok" });
    if (parsedLegacy._tag === "ok")
      expect(parsedLegacy.value.mergeEvidence).toBeUndefined();
    expect(
      parseReviewRemoteSnapshot({
        ...snapshot,
        mergeEvidence: {
          ...snapshot.mergeEvidence,
          mergeStateStatus: "not-a-status",
        },
      }),
    ).toMatchObject({ _tag: "err" });
  });

  it("rejects an address whose contents do not match its hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-remote-"));
    roots.push(root);
    const store = new ReviewRemoteStore(PatchdeskPaths.forTest(root));
    const saved = await store.saveCandidate({ profileId, reviewId, snapshot });
    if (saved._tag === "err") throw new Error("fixture");
    await expect(
      store.load({
        profileId,
        reviewId,
        // SAFETY: a deliberately wrong-but-well-formed hex digest, chosen so it will not match `snapshot`'s real content hash; the ContentHash brand only exists for compile-time cross-boundary safety, so this fixture literal may bypass it directly.
        snapshotHash: "0".repeat(64) as never,
      }),
    ).resolves.toMatchObject({ _tag: "err" });
  });
});
