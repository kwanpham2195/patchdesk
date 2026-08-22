import { describe, expect, it } from "vitest";
import {
  createReviewRefreshFixture,
  createReviewRefreshFixtureValues,
  createReviewRefreshSession,
} from "./review-refresh-fixture";
import { hashSnapshot } from "../../src/adapters/storage/review-remote-store";
import { type Review } from "../../src/domain/review";
import {
  parseGitSha,
  parseGitHubThreadId,
  parseIsoTimestamp,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";

const { profileId, identity, headSha, at, snapshot, review } =
  createReviewRefreshFixtureValues();
const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
};
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

  it("marks a changed head even when old-head checks are unavailable", async () => {
    const nextHead = must(parseGitSha("2".repeat(40)));

    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: { ...snapshot.pullRequest, headSha: nextHead },
      checksResult: err({ _tag: "GitHubReadFailed", operation: "get_checks" }),
    });
    await expect(
      service.detect({ profileId, reviewId: review.id }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { updatesAvailable: true, detectedAt: "2026-08-01T00:10:00.000Z" },
    });
    expect(calls.savedReviews).toHaveLength(1);
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

  it("does not mark a Published-feedback Review when the current reader omits optional feedback", async () => {
    const represented = {
      ...snapshot,
      publishedFeedback: { reviews: [], comments: [], complete: true },
    };
    const publishedReview: Review = {
      ...review,
      representedRemote: {
        headSha,
        pullRequestUpdatedAt: at,
        refreshedAt: at,
        snapshotHash: hashSnapshot(represented),
      },
    };

    const { service, calls } = createReviewRefreshFixture({
      review: publishedReview,
      representedSnapshot: represented,
    });
    await expect(
      service.detect({ profileId, reviewId: publishedReview.id }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("does not mark a review when only time has elapsed", async () => {
    const { service, calls } = createReviewRefreshFixture();
    await expect(
      service.detect({ profileId, reviewId: review.id }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("heals a phantom detection flag when GitHub's updatedAt lags the snapshot content", async () => {
    // GitHub's pullRequest.updatedAt lagged comment creation during the
    // represented refresh, so the record's marker predates content the
    // snapshot already holds and a previous detect pass flagged an update.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const detectedAt = must(parseIsoTimestamp("2026-08-01T00:06:00.000Z"));
    const represented = {
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
    const markedReview: Review = {
      ...review,
      representedRemote: {
        headSha,
        pullRequestUpdatedAt: at,
        refreshedAt: at,
        snapshotHash: hashSnapshot(represented),
      },
      freshness: {
        _tag: "Unavailable",
        detectedAt,
        reason: "comparison_ambiguous",
      },
    };
    const { service, calls } = createReviewRefreshFixture({
      review: markedReview,
      representedSnapshot: represented,
      currentPullRequest: { ...represented.pullRequest, updatedAt: commentAt },
      commentsResult: ok({
        ...represented.comments,
        threads: represented.comments.threads.map((thread) => ({
          ...thread,
          comments: thread.comments.map((comment) => ({
            ...comment,
            viewerDidAuthor: true,
          })),
        })),
      }),
    });
    await expect(
      service.detect({ profileId, reviewId: markedReview.id }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("does not save again when a healed review is re-detected unchanged", async () => {
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const represented = {
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
    const healedReview: Review = {
      ...review,
      representedRemote: {
        headSha,
        pullRequestUpdatedAt: commentAt,
        refreshedAt: at,
        snapshotHash: hashSnapshot(represented),
      },
    };

    const { service, calls } = createReviewRefreshFixture({
      review: healedReview,
      representedSnapshot: represented,
      currentPullRequest: { ...represented.pullRequest, updatedAt: commentAt },
      commentsResult: ok(represented.comments),
    });
    await expect(
      service.detect({ profileId, reviewId: healedReview.id }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("marks a real new comment as an update and does not re-save the same reason", async () => {
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const changed = {
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
                body: "new",
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

    const marked: Review = {
      ...review,
      freshness: {
        _tag: "Unavailable",
        detectedAt: must(parseIsoTimestamp("2026-08-01T00:07:00.000Z")),
        reason: "comparison_ambiguous",
      },
    };
    const { service, calls } = createReviewRefreshFixture({
      review: marked,
      commentsResult: ok(changed.comments),
    });
    await expect(
      service.detect({ profileId, reviewId: marked.id }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { updatesAvailable: true, detectedAt: "2026-08-01T00:07:00.000Z" },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("ignores comments and threads written by this app session when detecting updates", async () => {
    // The remote gained the user's own comment (created via the app since the
    // represented snapshot); the write journal must keep it from reading as a
    // remote update, and a genuine external reply must still be detected.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const ownThread = must(parseGitHubThreadId("t"));
    const ownComment = {
      id: "c-own",
      author: "pmquan2",
      body: "own",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
      location: {
        path: must(parseRepoRelativePath("a.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
    };
    const changed = {
      ...snapshot,
      comments: {
        threads: [
          { id: ownThread, state: "open" as const, comments: [ownComment] },
        ],
        complete: true,
      },
    };

    const { service, calls } = createReviewRefreshFixture({
      commentsResult: ok(changed.comments),
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "Comment", commentId: ownComment.id }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("ignores a label change written by this app session when detecting updates", async () => {
    // GitHub already reports the added label (the mutation already
    // succeeded); the represented snapshot just predates it. The journal
    // must keep that alone from reading as a remote update.
    const changed = {
      ...snapshot,
      pullRequest: {
        ...snapshot.pullRequest,
        labels: [{ name: "bug", color: "d73a4a" }],
      },
    };

    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: changed.pullRequest,
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "LabelChange", added: ["bug"], removed: [] }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("still detects an unrelated label change when a different label is journaled", async () => {
    // The journal masks only the exact app-owned label names; a different
    // label added remotely must still read as updates available.
    const changed = {
      ...snapshot,
      pullRequest: {
        ...snapshot.pullRequest,
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "priority", color: "ffcc00" },
        ],
      },
    };

    const { service, calls } = createReviewRefreshFixture({
      currentPullRequest: changed.pullRequest,
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "LabelChange", added: ["bug"], removed: [] }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { updatesAvailable: true, detectedAt: "2026-08-01T00:10:00.000Z" },
    });
    expect(calls.savedReviews.length).toBeGreaterThan(0);
  });

  it("unions the durable own-write journal into detect() so a renderer reload does not read the maintainer's own comment as a remote update", async () => {
    // Defense in depth (Current State: detect() is unreachable in production
    // today): the same reload scenario as the test above, but the write is
    // proven only by the durable journal, not the request. This is the
    // literal scenario the original brief described, now correctly targeting
    // code that would already behave correctly if ever reconnected to a live
    // route.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const ownThread = must(parseGitHubThreadId("t-durable"));
    const ownComment = {
      id: "c-own-durable",
      author: "pmquan2",
      body: "own",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r2",
      location: {
        path: must(parseRepoRelativePath("a.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
    };
    const changed = {
      ...snapshot,
      comments: {
        threads: [
          { id: ownThread, state: "open" as const, comments: [ownComment] },
        ],
        complete: true,
      },
    };

    const { service, calls } = createReviewRefreshFixture({
      commentsResult: ok(changed.comments),
      recentWrites: [{ _tag: "Comment", commentId: ownComment.id }],
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("ignores a pending-review thread this session started or added when detecting updates", async () => {
    // Start/AddThread creates a pending-review thread that only the candidate
    // snapshot contains; the journaled PendingThread entry must keep the
    // app's own thread from reading as a remote update.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const pendingThread = must(parseGitHubThreadId("pending-own"));
    const ownComment = {
      id: "PRRC_own",
      author: "pmquan2",
      body: "own",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
      location: {
        path: must(parseRepoRelativePath("a.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
    };
    const changed = {
      ...snapshot,
      comments: {
        threads: [
          { id: pendingThread, state: "open" as const, comments: [ownComment] },
        ],
        complete: true,
      },
    };

    const { service, calls } = createReviewRefreshFixture({
      commentsResult: ok(changed.comments),
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "PendingThread", threadId: pendingThread }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("ignores a pending-review thread this session discarded when detecting updates", async () => {
    // Discard removes the pending thread remotely, so only the represented
    // snapshot still contains it; symmetric removal must keep the app's own
    // removal from reading as a remote update.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const pendingThread = must(parseGitHubThreadId("pending-own"));
    const ownComment = {
      id: "PRRC_own",
      author: "pmquan2",
      body: "own",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
      location: {
        path: must(parseRepoRelativePath("a.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
    };
    const represented = {
      ...snapshot,
      comments: {
        threads: [
          { id: pendingThread, state: "open" as const, comments: [ownComment] },
        ],
        complete: true,
      },
    };

    const { service, calls } = createReviewRefreshFixture({
      review: {
        ...review,
        representedRemote: {
          headSha,
          pullRequestUpdatedAt: at,
          refreshedAt: at,
          snapshotHash: hashSnapshot(represented),
        },
      },
      representedSnapshot: represented,
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "PendingThread", threadId: pendingThread }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("still detects an unrelated thread when a pending thread is journaled", async () => {
    // The journal masks only the exact app-owned thread id; a different
    // thread added remotely must still read as updates available.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const ownThread = must(parseGitHubThreadId("pending-own"));
    const externalThread = must(parseGitHubThreadId("external-1"));
    const ownComment = {
      id: "PRRC_own",
      author: "pmquan2",
      body: "own",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
      location: {
        path: must(parseRepoRelativePath("a.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
    };
    const externalComment = {
      id: "PRRC_external",
      author: "reviewer",
      body: "Question",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
      location: {
        path: must(parseRepoRelativePath("b.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
    };
    const changed = {
      ...snapshot,
      comments: {
        threads: [
          { id: ownThread, state: "open" as const, comments: [ownComment] },
          {
            id: externalThread,
            state: "open" as const,
            comments: [externalComment],
          },
        ],
        complete: true,
      },
    };

    const { service } = createReviewRefreshFixture({
      commentsResult: ok(changed.comments),
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "PendingThread", threadId: ownThread }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { updatesAvailable: true, detectedAt: "2026-08-01T00:10:00.000Z" },
    });
  });

  it("ignores the review and feedback comment a create submits when detecting updates", async () => {
    // A comment create submits its own COMMENTED review; the journal must
    // exclude that review (numeric id) and its comment (node id) from both
    // sides of the fingerprint, or the write would flag itself as an update.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const ownComment = {
      id: "PRRC_own",
      nodeId: "PRRC_own",
      author: "pmquan2",
      body: "own",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
      location: {
        path: must(parseRepoRelativePath("a.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
      reviewId: "42",
      canEdit: true,
      canDelete: true,
    };
    const ownReview = {
      id: "42",
      nodeId: "PRR_own",
      author: "pmquan2",
      body: "",
      event: "COMMENTED" as const,
      submittedAt: commentAt,
      canDismiss: true,
    };
    const changed = {
      ...snapshot,
      comments: {
        threads: [
          {
            id: must(parseGitHubThreadId("t")),
            state: "open" as const,
            comments: [ownComment],
          },
        ],
        complete: true,
      },
      publishedFeedback: {
        reviews: [ownReview],
        comments: [ownComment],
        complete: true,
      },
    };
    const represented = {
      ...snapshot,
      publishedFeedback: { reviews: [], comments: [], complete: true },
    };

    const { service, calls } = createReviewRefreshFixture({
      review: {
        ...review,
        representedRemote: {
          headSha,
          pullRequestUpdatedAt: at,
          refreshedAt: at,
          snapshotHash: hashSnapshot(represented),
        },
      },
      representedSnapshot: represented,
      commentsResult: ok(changed.comments),
      publishedFeedbackResult: ok(changed.publishedFeedback),
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [
          { _tag: "Comment", commentId: "PRRC_own", reviewId: "42" },
        ],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("ignores a direct summary review this session submitted when detecting updates", async () => {
    const submittedAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const ownReview = {
      id: "42",
      nodeId: "PRR_own",
      author: "pmquan2",
      body: "Summary",
      event: "COMMENTED" as const,
      submittedAt,
      canDismiss: true,
    };
    const represented = {
      ...snapshot,
      publishedFeedback: { reviews: [], comments: [], complete: true },
    };
    const changed = {
      ...snapshot,
      publishedFeedback: { reviews: [ownReview], comments: [], complete: true },
    };

    const { service, calls } = createReviewRefreshFixture({
      review: {
        ...review,
        representedRemote: {
          headSha,
          pullRequestUpdatedAt: at,
          refreshedAt: at,
          snapshotHash: hashSnapshot(represented),
        },
      },
      representedSnapshot: represented,
      publishedFeedbackResult: ok(changed.publishedFeedback),
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "DirectSummaryReview", reviewId: "42" }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        updatesAvailable: false,
        detectedAt: "2026-08-01T00:10:00.000Z",
      },
    });
    expect(calls.savedReviews).toHaveLength(0);
  });

  it("detects an external reply inside a thread this session resolved (no whole-thread masking)", async () => {
    // The app resolved thread t locally; the journal carries a ThreadState
    // entry. An external reply then lands in that same thread. Normalization
    // must keep the thread (masking only the app's own state change) so the
    // external reply reads as a remote update and blocks later writes.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const threadId = must(parseGitHubThreadId("t"));
    const external = {
      id: "c-external",
      author: "reviewer",
      body: "Reply",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
      location: {
        path: must(parseRepoRelativePath("a.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
    };
    const represented = {
      ...snapshot,
      comments: {
        threads: [
          { id: threadId, state: "open" as const, comments: [external] },
        ],
        complete: true,
      },
    };
    const candidate = {
      ...represented,
      comments: {
        threads: [
          {
            id: threadId,
            state: "resolved" as const,
            comments: [
              external,
              {
                ...external,
                id: "c-external-2",
                body: "Another reply",
                createdAt: must(parseIsoTimestamp("2026-08-01T00:06:00.000Z")),
              },
            ],
          },
        ],
        complete: true,
      },
    };

    const { service } = createReviewRefreshFixture({
      review: {
        ...review,
        representedRemote: {
          headSha,
          pullRequestUpdatedAt: at,
          refreshedAt: at,
          snapshotHash: hashSnapshot(represented),
        },
      },
      representedSnapshot: represented,
      commentsResult: ok(candidate.comments),
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "ThreadState", threadId, state: "resolved" }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { updatesAvailable: true, detectedAt: "2026-08-01T00:10:00.000Z" },
    });
  });

  it("detects an external thread-state change after a local resolve", async () => {
    // The app resolved thread t locally (journaled ThreadState resolved).
    // Another reviewer re-opens it. Normalization forces only the represented
    // side to the journaled state; the candidate's open state must differ and
    // block writes until an explicit refresh re-baselines.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const threadId = must(parseGitHubThreadId("t"));
    const external = {
      id: "c-external",
      author: "reviewer",
      body: "Question",
      createdAt: commentAt,
      updatedAt: commentAt,
      url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1",
      location: {
        path: must(parseRepoRelativePath("a.go")),
        line: 1,
        lineEnd: 1,
        diffSide: "new" as const,
      },
    };
    const represented = {
      ...snapshot,
      comments: {
        threads: [
          { id: threadId, state: "open" as const, comments: [external] },
        ],
        complete: true,
      },
    };

    const { service } = createReviewRefreshFixture({
      review: {
        ...review,
        representedRemote: {
          headSha,
          pullRequestUpdatedAt: at,
          refreshedAt: at,
          snapshotHash: hashSnapshot(represented),
        },
      },
      representedSnapshot: represented,
      commentsResult: ok(represented.comments),
    });
    await expect(
      service.detect({
        profileId,
        reviewId: review.id,
        recentWrites: [{ _tag: "ThreadState", threadId, state: "resolved" }],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { updatesAvailable: true, detectedAt: "2026-08-01T00:10:00.000Z" },
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

  it("still succeeds when the injected avatar sync fails (avatars are decorative, never fatal)", async () => {
    const { service } = createReviewRefreshFixture({ avatarSyncFailure: true });
    await expect(
      service.refresh({ profileId, reviewId: review.id }),
    ).resolves.toMatchObject({ _tag: "ok" });
  });
});
