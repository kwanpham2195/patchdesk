import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ok } from "../../src/domain/result";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewWriteGate } from "../../src/services/review-write-gate";
import {
  ReviewRemoteStore,
  type ReviewRemoteSnapshot,
} from "../../src/adapters/storage/review-remote-store";
import { createReview, markReviewUnavailable } from "../../src/domain/review";
import {
  createReviewSession,
  type ReviewSession,
} from "../../src/domain/review-session";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import type { Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T =>
  result._tag === "ok"
    ? result.value
    : (() => {
        throw new Error("fixture");
      })();
const profileId = must(parseWorkspaceProfileId("cfw"));
const key = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
  headSha: must(parseGitSha("1".repeat(40))),
  baseSha: must(parseGitSha("0".repeat(40))),
};
const at = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReviewWriteGate", () => {
  it("requires represented, matching, undetected state", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-gate-"));
    roots.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const profiles = new ProfileStore(paths);
    const sessions = new ReviewSessionStore(paths);
    const reviews = new ReviewStore(paths);
    const remote = new ReviewRemoteStore(paths);
    const profile = must(
      parseWorkspaceProfileConfig({
        id: profileId,
        label: "CFW",
        githubHost: "github.com",
        ghAccount: "fixture",
        workspaceRoots: [],
        rulePaths: [],
        repos: [],
      }),
    );
    await profiles.save(profile);
    const session = createReviewSession({
      key,
      pr: {
        headSha: key.headSha,
        baseSha: key.baseSha,
        isDraft: false,
        isOpen: true,
      },
      patchPath: must(
        // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
        parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never)),
      ),
      worktree: {
        path: must(
          parseAbsolutePath(
            // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
            paths.worktreeDirectory(profileId, "placeholder" as never),
          ),
        ),
        headSha: key.headSha,
      },
      createdAt: at,
    });
    const storedSession: ReviewSession = {
      ...session,
      patchPath: must(
        parseAbsolutePath(paths.patchFile(profileId, session.id)),
      ),
      worktree: {
        path: must(
          parseAbsolutePath(paths.worktreeDirectory(profileId, session.id)),
        ),
        headSha: key.headSha,
      },
    };
    await sessions.save(storedSession);
    const snapshot: ReviewRemoteSnapshot = {
      schemaVersion: 1,
      pullRequest: {
        ref: {
          host: key.host,
          owner: key.owner,
          repo: key.repo,
          number: key.prNumber,
        },
        headSha: key.headSha,
        isDraft: false,
        isOpen: true,
        title: "Fixture",
        author: "fixture",
        headBranch: "main",
        baseBranch: "sit",
        reviewState: "none",
        mergeability: "mergeable",
        labels: [],
        updatedAt: at,
      },
      comments: { threads: [], complete: true },
      commits: [],
      checks: { overall: "passing", checks: [] },
      conversation: { prDescription: "", entries: [] },
    };
    const savedSnapshot = await remote.saveCandidate({
      profileId,
      reviewId: createReview({
        identity: {
          profileId: key.profileId,
          host: key.host,
          owner: key.owner,
          repo: key.repo,
          prNumber: key.prNumber,
        },
        currentSessionId: storedSession.id,
        headSha: key.headSha,
        createdAt: at,
      }).id,
      snapshot,
    });
    if (savedSnapshot._tag === "err") throw new Error("fixture");
    const review = {
      ...createReview({
        identity: {
          profileId: key.profileId,
          host: key.host,
          owner: key.owner,
          repo: key.repo,
          prNumber: key.prNumber,
        },
        currentSessionId: storedSession.id,
        headSha: key.headSha,
        createdAt: at,
      }),
      representedRemote: {
        headSha: key.headSha,
        pullRequestUpdatedAt: at,
        snapshotHash: savedSnapshot.value.snapshotHash,
        refreshedAt: at,
      },
      freshness: { _tag: "Fresh" as const },
    };
    await reviews.save(review);
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    const gate = new ReviewWriteGate(profiles, reviews, sessions, remote, {
      load: async () => ok(undefined),
    } as never);
    await expect(
      gate.requireFresh(profileId, review.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { session: { id: storedSession.id } },
    });
    const mismatchedSnapshot = {
      ...snapshot,
      pullRequest: {
        ...snapshot.pullRequest,
        headSha: must(parseGitSha("2".repeat(40))),
      },
    };
    const mismatched = await remote.saveCandidate({
      profileId,
      reviewId: review.id,
      snapshot: mismatchedSnapshot,
    });
    if (mismatched._tag === "err") throw new Error("fixture");
    await reviews.save(
      {
        ...review,
        representedRemote: {
          ...review.representedRemote,
          snapshotHash: mismatched.value.snapshotHash,
        },
        // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
        updatedAt: "2026-08-01T00:00:00.001Z" as never,
      },
      review.updatedAt,
    );
    await expect(
      gate.requireFresh(profileId, review.id),
    ).resolves.toMatchObject({ _tag: "err", error: { reason: "stale" } });
    const mismatchedReview = await reviews.load(profileId, review.id);
    if (mismatchedReview._tag === "err") throw new Error("fixture");
    await reviews.save(
      {
        ...mismatchedReview.value,
        representedRemote: review.representedRemote,
        // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
        updatedAt: "2026-08-01T00:00:00.002Z" as never,
      },
      mismatchedReview.value.updatedAt,
    );
    const restored = await reviews.load(profileId, review.id);
    if (restored._tag === "err") throw new Error("fixture");
    const marked = markReviewUnavailable(
      restored.value,
      { detectedAt: at, reason: "comparison_ambiguous" },
      restored.value.updatedAt,
    );
    await reviews.save(marked, restored.value.updatedAt);
    await expect(
      gate.requireFresh(profileId, review.id),
    ).resolves.toMatchObject({ _tag: "err", error: { reason: "not_fresh" } });
  });
});

/**
 * The revision agreement `sessionRepresentsReview` enforces, pinned at the
 * gate rather than only on the helper.
 *
 * Both gate methods hand the caller a `session` that every later step then
 * trusts: `requireCurrentHead` builds its `getPullRequest` argument out of
 * `session.key.{host,owner,repo,prNumber}`, and the writes that follow target
 * that same pull request at that same head. A predicate that answered `true`
 * too often would let the gate return a session naming a different pull
 * request, or a head the Review has already moved past, and the write would
 * land there. These two cases are the ones no other condition in either
 * method covers: `requireCurrentSession` has no second head check at all, and
 * `requireFresh`'s second disjunct only re-checks the head, so its five
 * identity fields rest on the helper alone.
 */
describe("ReviewWriteGate revision agreement", () => {
  const identity = {
    profileId: key.profileId,
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    prNumber: key.prNumber,
  };
  const movedHeadSha = must(parseGitSha("9".repeat(40)));
  const profile = must(
    parseWorkspaceProfileConfig({
      id: profileId,
      label: "CFW",
      githubHost: "github.com",
      ghAccount: "fixture",
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    }),
  );
  const review = {
    ...createReview({
      identity,
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      currentSessionId: "session-1" as never,
      headSha: key.headSha,
      createdAt: at,
    }),
    representedRemote: {
      headSha: key.headSha,
      pullRequestUpdatedAt: at,
      // SAFETY: This literal is a well-formed 64-character content-hash fixture.
      snapshotHash: "a".repeat(64) as never,
      refreshedAt: at,
    },
    freshness: { _tag: "Fresh" as const },
  };
  const snapshot = {
    schemaVersion: 1,
    pullRequest: {
      ref: {
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.prNumber,
      },
      headSha: key.headSha,
      isDraft: false,
      isOpen: true,
      title: "Fixture",
      author: "fixture",
      headBranch: "main",
      baseBranch: "sit",
      reviewState: "none",
      mergeability: "mergeable",
      labels: [],
      updatedAt: at,
    },
    comments: { threads: [], complete: true },
    commits: [],
    checks: { overall: "passing", checks: [] },
    conversation: { prDescription: "", entries: [] },
  };

  function gateFor(sessionKey: typeof key) {
    // SAFETY: each fake below stubs only the one `load` the gate calls, and
    // returns a fixture already shaped like the record that store yields;
    // the casts stay at the test seam.
    return new ReviewWriteGate(
      { load: async () => ok(profile) } as never,
      { load: async () => ok(review) } as never,
      { load: async () => ok({ id: "session-1", key: sessionKey }) } as never,
      { load: async () => ok(snapshot) } as never,
      { load: async () => ok(undefined) } as never,
    );
  }

  it("requireCurrentSession refuses a session the Review's head has moved past", async () => {
    await expect(
      gateFor({ ...key }).requireCurrentSession(profileId, review.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { review: { id: review.id } },
    });
    await expect(
      gateFor({ ...key, headSha: movedHeadSha }).requireCurrentSession(
        profileId,
        review.id,
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "stale" } });
  });

  it("requireFresh refuses a session keyed to a different pull request", async () => {
    await expect(
      gateFor({ ...key }).requireFresh(profileId, review.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { session: { id: "session-1" } },
    });
    for (const mismatch of [
      { host: must(parseGitHubHost("ghe.example.com")) },
      { owner: must(parseGitHubOwner("someone-else")) },
      { repo: must(parseGitHubRepoName("other-repo")) },
      { prNumber: must(parsePullRequestNumber(43)) },
    ]) {
      await expect(
        gateFor({ ...key, ...mismatch }).requireFresh(profileId, review.id),
      ).resolves.toEqual({ _tag: "err", error: { reason: "stale" } });
    }
  });
});
