import { describe, expect, it } from "vitest";
import {
  createReviewRefreshFixture,
  createReviewRefreshFixtureValues,
  createReviewRefreshSession,
} from "./review-refresh-fixture";
import {
  parseGitSha,
  parseGitHubThreadId,
  parseIsoTimestamp,
  parsePendingReviewRequestId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";

const { profileId, identity, headSha, at, snapshot, review } =
  createReviewRefreshFixtureValues();
const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
};
const changedBaseSha = must(parseGitSha("c".repeat(40)));
describe("ReviewRefreshService", () => {
  it("rejects a refresh when the current session is missing before writing a candidate", async () => {
    const { service, calls } = createReviewRefreshFixture({
      sessionLoad: err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "not_found",
      }),
    });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "not_found" } });
    expect(calls.savedCandidates).toHaveLength(0);
  });

  it("rejects a refresh when the first GitHub read has no base SHA", async () => {
    const { baseSha: _baseSha, ...withoutBase } = snapshot.pullRequest;
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: withoutBase,
    });

    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "github_read" } });
    expect(calls.savedCandidates).toEqual([]);
    expect(calls.savedReviews).toEqual([]);
  });

  it("keeps the current session when the immutable head/base pair is unchanged", async () => {
    const { service, calls } = createReviewRefreshFixture();

    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(calls.preparations).toEqual([]);
    expect(calls.savedSessions).toEqual([]);
  });

  it("prepares a distinct session when only the PR base changes", async () => {
    const changedSnapshot = {
      ...snapshot,
      pullRequest: { ...snapshot.pullRequest, baseSha: changedBaseSha },
    };
    const preparedSession = createReviewRefreshSession({
      identity,
      snapshot: changedSnapshot,
      createdAt: at,
      headSha,
    });
    const { service, calls } = createReviewRefreshFixture({
      session: {
        ...createReviewRefreshFixtureValues().session,
        pendingReview: { _tag: "None" },
      },
      currentPullRequest: changedSnapshot.pullRequest,
      preparedSession,
    });

    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(calls.preparations).toEqual(["prepare"]);
    expect(calls.savedSessions).toHaveLength(1);
    expect(calls.savedSessions[0]?.key.baseSha).toBe(changedBaseSha);
    expect(calls.savedSessions[0]?.pendingReview).toBeUndefined();
  });

  it("maps a preparation authentication failure onto the github_auth reason", async () => {
    const changedSnapshot = {
      ...snapshot,
      pullRequest: { ...snapshot.pullRequest, baseSha: changedBaseSha },
    };
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: changedSnapshot.pullRequest,
      preparationFailure: { _tag: "GitHubAuthenticationFailed" },
    });

    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "github_auth" } });
    expect(calls.preparations).toEqual(["prepare"]);
    expect(calls.savedSessions).toEqual([]);
  });

  it("does not project old pending-review state after a base-only replacement", async () => {
    const changedSnapshot = {
      ...snapshot,
      pullRequest: { ...snapshot.pullRequest, baseSha: changedBaseSha },
    };
    const oldPendingReview = {
      _tag: "WriteInFlight" as const,
      operation: {
        _tag: "Start" as const,
        requestId: must(parsePendingReviewRequestId("pending-review-refresh")),
      },
      startedAt: at,
    };
    const preparedSession = createReviewRefreshSession({
      identity,
      snapshot: changedSnapshot,
      createdAt: at,
      headSha,
    });
    const { service, calls } = createReviewRefreshFixture({
      session: {
        ...createReviewRefreshFixtureValues().session,
        pendingReview: oldPendingReview,
      },
      currentPullRequest: changedSnapshot.pullRequest,
      preparedSession,
      pendingReviewReconcileResult: err("unavailable"),
      projectionOutcome: "success",
    });

    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(calls.projectionInputs[0]?.pendingReview).toEqual({
      state: { _tag: "None" },
      unavailable: true,
    });
  });

  it("rejects a base race between the first and final GitHub reads", async () => {
    const changedSnapshot = {
      ...snapshot,
      pullRequest: { ...snapshot.pullRequest, baseSha: changedBaseSha },
    };
    const { service, calls } = createReviewRefreshFixture({
      pullRequestResults: [
        ok(snapshot.pullRequest),
        ok(changedSnapshot.pullRequest),
      ],
    });

    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "head_changed" } });
    expect(calls.savedReviews).toEqual([]);
    expect(calls.clearedRecentWrites).toEqual([]);
  });

  it("rejects a prepared session with the wrong base", async () => {
    const changedSnapshot = {
      ...snapshot,
      pullRequest: { ...snapshot.pullRequest, baseSha: changedBaseSha },
    };
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: changedSnapshot.pullRequest,
      preparedSession: createReviewRefreshSession({
        identity,
        snapshot,
        createdAt: at,
        headSha,
      }),
    });

    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "head_changed" } });
    expect(calls.savedReviews).toEqual([]);
  });

  it("rejects a refresh when the current session head no longer matches the Review", async () => {
    const mismatchedHead = must(parseGitSha("9".repeat(40)));

    const { service, calls } = createReviewRefreshFixture({
      session: {
        ...createReviewRefreshSession({
          identity,
          snapshot,
          createdAt: at,
          headSha: mismatchedHead,
        }),
        id: review.currentSessionId,
      },
    });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "head_changed" } });
    expect(calls.savedCandidates).toHaveLength(0);
  });

  it("keeps an open merge outcome open instead of terminalizing the Review", async () => {
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: { ...snapshot.pullRequest, isOpen: false },
      mergeOutcomeResult: ok({ state: "open" }),
    });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(calls.savedReviews.at(-1)?.status).toEqual({ _tag: "Open" });
  });

  it("maps a terminal-only session preparation reopen to terminal", async () => {
    const nextHead = must(parseGitSha("2".repeat(40)));
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: {
        ...snapshot.pullRequest,
        headSha: nextHead,
        isOpen: false,
      },
      preparationFailure: { _tag: "PullRequestStateChanged" },
      mergeOutcomeResult: ok({ state: "merged", mergedAt: at }),
    });

    await expect(
      service.refresh({
        profileId,
        reviewId: review.id,
        expectedTerminalState: "merged",
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "terminal" } });
    expect(calls.savedReviews).toEqual([]);
  });

  it("rejects a prepared session whose head raced beyond the fetched snapshot", async () => {
    const nextHead = must(parseGitSha("2".repeat(40)));
    const racedHead = must(parseGitSha("3".repeat(40)));
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: { ...snapshot.pullRequest, headSha: nextHead },
      preparedSession: createReviewRefreshSession({
        identity,
        snapshot,
        createdAt: at,
        headSha: racedHead,
      }),
    });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "head_changed" } });
    expect(calls.savedReviews).toEqual([]);
  });

  it("persists optional policy evidence during explicit refresh", async () => {
    const { service, calls } = createReviewRefreshFixture({
      mergePolicyResult: ok({
        pr: {
          host: identity.host,
          owner: identity.owner,
          repo: identity.repo,
          number: identity.prNumber,
        },
        headSha,
        isOpen: true,
        isDraft: false,
        mergeability: "blocked",
        mergeStateStatus: "blocked",
        reviewDecision: "review_required",
        checks: snapshot.checks,
        complete: true,
      }),
      mergePolicyEvidenceResult: ok({
        branchProtection: {
          state: "available",
          value: { requiredApprovingReviewCount: 1 },
        },
        appliedRuleset: { state: "unavailable", reason: "forbidden" },
      }),
    });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(
      calls.savedCandidates[0]?.mergeEvidence?.policy?.branchProtection,
    ).toEqual({
      state: "available",
      value: { requiredApprovingReviewCount: 1 },
    });
  });

  it("flattens a projected refresh result instead of nesting the Result envelope", async () => {
    const { service } = createReviewRefreshFixture({
      projectionOutcome: "success",
    });
    const refreshed = await service.refresh({ profileId, reviewId: review.id });
    expect(refreshed).toMatchObject({
      _tag: "ok",
      value: { state: "review", review: { id: review.id, status: "open" } },
    });
  });

  it("maps a projection failure after persistence without returning a nested success", async () => {
    const { service } = createReviewRefreshFixture({
      projectionOutcome: "failure",
    });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "storage" } });
  });

  it("persists merged rather than closed from authoritative GitHub outcome", async () => {
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: { ...snapshot.pullRequest, isOpen: false },
      mergeOutcomeResult: ok({ state: "merged", mergedAt: at }),
    });
    const refreshed = await service.refresh({ profileId, reviewId: review.id });
    expect(refreshed._tag).toBe("ok");
    expect(calls.savedReviews.at(-1)?.status).toEqual({
      _tag: "Terminal",
      state: "merged",
      observedAt: "2026-08-01T00:10:00.000Z",
    });
  });

  it("requires merged evidence before terminal-only refresh persists a Review", async () => {
    const closed = { ...snapshot.pullRequest, isOpen: false };
    const outcomes = [
      {
        name: "open",
        pullRequest: snapshot.pullRequest,
        mergeOutcome: ok({ state: "open" as const }),
      },
      {
        name: "closed unmerged",
        pullRequest: closed,
        mergeOutcome: ok({ state: "closed_unmerged" as const }),
      },
      { name: "missing outcome", pullRequest: closed, mergeOutcome: undefined },
    ];

    for (const outcome of outcomes) {
      const fixture =
        outcome.mergeOutcome === undefined
          ? createReviewRefreshFixture({
              currentPullRequest: outcome.pullRequest,
            })
          : createReviewRefreshFixture({
              currentPullRequest: outcome.pullRequest,
              mergeOutcomeResult: outcome.mergeOutcome,
            });
      await expect(
        fixture.service.refresh({
          profileId,
          reviewId: review.id,
          expectedTerminalState: "merged",
        }),
        outcome.name,
      ).resolves.toEqual({ _tag: "err", error: { reason: "terminal" } });
      expect(fixture.calls.savedReviews, outcome.name).toEqual([]);
    }
  });

  it("rejects a reopen race during terminal-only refresh before persisting a Review", async () => {
    const closed = { ...snapshot.pullRequest, isOpen: false };
    const { service, calls } = createReviewRefreshFixture({
      pullRequestResults: [ok(closed), ok(snapshot.pullRequest)],
      mergeOutcomeResult: ok({ state: "merged", mergedAt: at }),
    });

    await expect(
      service.refresh({
        profileId,
        reviewId: review.id,
        expectedTerminalState: "merged",
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "terminal" } });
    expect(calls.savedReviews).toEqual([]);
  });

  it("persists a merged terminal Review after terminal-only refresh", async () => {
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: { ...snapshot.pullRequest, isOpen: false },
      mergeOutcomeResult: ok({ state: "merged", mergedAt: at }),
    });

    await expect(
      service.refresh({
        profileId,
        reviewId: review.id,
        expectedTerminalState: "merged",
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(calls.savedReviews.at(-1)?.status).toEqual({
      _tag: "Terminal",
      state: "merged",
      observedAt: "2026-08-01T00:10:00.000Z",
    });
  });

  it("records the derived comment moment when refresh observes lagging PR updatedAt", async () => {
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const lagging = {
      ...snapshot,
      pullRequest: { ...snapshot.pullRequest, updatedAt: at },
    };
    const withComment = {
      ...snapshot,
      comments: {
        threads: [
          {
            id: must(parseGitHubThreadId("t")),
            state: "open" as const,
            comments: [
              {
                id: "c",
                author: "pmquan2",
                body: "test",
                createdAt: commentAt,
                updatedAt: commentAt,
                url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
                location: {
                  path: must(parseRepoRelativePath("a.go")),
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
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: lagging.pullRequest,
      commentsResult: ok(withComment.comments),
    });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(
      calls.savedReviews.at(-1)?.representedRemote?.pullRequestUpdatedAt,
    ).toBe(commentAt);
  });

  it("records a plain conversation comment's moment, which no review thread carries", async () => {
    const issueCommentAt = must(parseIsoTimestamp("2026-08-01T00:07:00.000Z"));
    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: { ...snapshot.pullRequest, updatedAt: at },
      publishedFeedbackResult: ok({
        reviews: [],
        comments: [],
        issueComments: [
          {
            id: "ic-1",
            author: "pmquan2",
            body: "A plain conversation comment.",
            createdAt: issueCommentAt,
            updatedAt: issueCommentAt,
            url: "https://github.com/centraldigital/patchdesk/pull/42#issuecomment-1",
            canEdit: false,
            canDelete: false,
          },
        ],
        complete: true,
      }),
    });

    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(
      calls.savedReviews.at(-1)?.representedRemote?.pullRequestUpdatedAt,
    ).toBe(issueCommentAt);
  });

  it("still succeeds when the injected avatar sync fails (avatars are decorative, never fatal)", async () => {
    const { service } = createReviewRefreshFixture({ avatarSyncFailure: true });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
  });
});
