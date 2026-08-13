import { describe, expect, it, vi } from "vitest";

import { createReviewId } from "../../src/domain/ids";
import { err, ok } from "../../src/domain/result";
import { ReviewWorkbenchProjectionService } from "../../src/services/review-workbench-projection";

const profileId = "cfw" as never;
const headSha = "a".repeat(40) as never;
const at = "2026-08-09T11:35:00.000Z" as never;
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__b48f8e2e76ca" as never;
const identity = {
  profileId,
  host: "github.com" as never,
  owner: "centraldigital" as never,
  repo: "patchdesk" as never,
  prNumber: 42 as never,
};
const reviewId = createReviewId(identity);
const hash = "b".repeat(64) as never;
function session() {
  return {
    id: sessionId,
    key: { ...identity, headSha },
    pr: { headSha, baseSha: headSha, isDraft: false, isOpen: true },
    prContext: {
      title: "saved title",
      author: "author",
      headBranch: "feature",
      baseBranch: "sit",
    },
    patchPath: "/does-not-exist" as never,
    worktree: { path: "/tmp/worktree" as never, headSha },
    pendingReview: {
      _tag: "Pending",
      review: {
        nodeId: "node" as never,
        restId: "1" as never,
        headSha,
        comments: [],
        author: "fixture" as never,
        pr: identity,
        createdAt: at,
        updatedAt: at,
      },
    },
    directSummaryReview: {
      _tag: "Confirmed",
      receipt: {
        reviewId: "1" as never,
        event: "COMMENT",
        headSha,
        submittedAt: at,
      },
    },
    createdAt: at,
    updatedAt: at,
  } as never;
}
const snapshot = {
  schemaVersion: 1,
  pullRequest: {
    ref: identity,
    headSha,
    baseSha: headSha,
    title: "represented title",
    author: "author",
    headBranch: "feature",
    baseBranch: "sit",
    isDraft: false,
    isOpen: true,
    reviewState: "approved",
    mergeability: "mergeable",
    labels: [],
    updatedAt: at,
  },
  comments: { threads: [], complete: true },
  conversation: { prDescription: "represented description", entries: [] },
  commits: [
    {
      sha: headSha,
      message: "represented commit",
      author: "author",
      authoredAt: at,
      isHead: true,
    },
  ],
  checks: {
    overall: "passing",
    checks: [
      {
        name: "build",
        required: true,
        status: "completed",
        conclusion: "success",
      },
    ],
  },
  mergeEvidence: {
    mergeable: "mergeable",
    mergeStateStatus: "clean",
    reviewDecision: "approved",
  },
} as never;
function review(overrides: Record<string, unknown> = {}) {
  return {
    id: reviewId,
    identity,
    currentSessionId: sessionId,
    currentHeadSha: headSha,
    representedRemote: {
      headSha,
      pullRequestUpdatedAt: at,
      snapshotHash: hash,
      refreshedAt: at,
    },
    freshness: { _tag: "Fresh" },
    status: { _tag: "Open" },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as never;
}
function fixture(stable = review()) {
  const profiles = { load: vi.fn(async () => ok({ ghAccount: "fixture" })) };
  const sessions = { load: vi.fn(async () => ok(session())) };
  const reviews = { load: vi.fn(async () => ok(stable)) };
  const insights = {
    loadTyped: vi.fn(async () => err({ reason: "not_found" })),
    load: vi.fn(async () => err({ reason: "not_found" })),
  };
  return {
    service: new ReviewWorkbenchProjectionService(
      profiles as never,
      sessions as never,
      reviews as never,
      insights as never,
    ),
    profiles,
    sessions,
    reviews,
    insights,
  };
}

describe("ReviewWorkbenchProjectionService", () => {
  it("projects only the represented Review snapshot and performs no GitHub reads", async () => {
    const value = fixture();
    await expect(
      value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        review: { id: reviewId, status: "open" },
        revision: {
          freshness: "fresh",
          refreshedAt: at,
          reviewedHeadSha: headSha,
        },
        pullRequest: { title: "represented title" },
        commits: [{ message: "represented commit" }],
        checks: { overall: "passing" },
        conversation: { prDescription: "represented description" },
        pendingReview: { state: "pending" },
        directSummary: { state: "confirmed" },
      },
    });
    expect(value.profiles.load).toHaveBeenCalledOnce();
    expect(value.sessions.load).toHaveBeenCalledOnce();
    expect(value.reviews.load).toHaveBeenCalledOnce();
  });

  it("projects represented freshness, analysis and walkthrough defaults, and merge evidence", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: {
        _tag: "RevisionChanged",
        detectedAt: at,
        identity: { headSha, baseSha: headSha, canonicalPatchHash: hash },
      },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        revision: { freshness: "updates_available" },
        insights: {
          analysis: { status: "not_generated" },
          walkthrough: { status: "not_generated" },
        },
        mergeReadiness: { _tag: "Ready" },
        mergeReasons: [],
      },
    });
  });

  it("fails closed when the Review authority is missing or bound to another Session", async () => {
    const absent = fixture();
    absent.reviews.load.mockResolvedValueOnce(
      err({ reason: "not_found" } as never),
    );
    await expect(
      absent.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toEqual({ _tag: "err", error: { _tag: "ReviewNotFound" } });
    const mismatched = fixture(review({ currentSessionId: "other-session" }));
    await expect(
      mismatched.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "SessionStorageUnavailable" },
    });
  });

  it("never falls back to session-only context when the represented snapshot is complete", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Unavailable", detectedAt: at, reason: "github_read" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        pullRequest: { title: "represented title" },
        conversation: { prDescription: "represented description" },
        revision: { freshness: "unavailable" },
      },
    });
  });
});
