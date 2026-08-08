import { describe, expect, it, vi } from "vitest";
import { ReviewRefreshService } from "../../src/services/review-refresh-service";
import { hashSnapshot, type ReviewRemoteSnapshot } from "../../src/adapters/storage/review-remote-store";
import { createReview, type Review } from "../../src/domain/review";
import { createReviewSessionId, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseGitHubThreadId, parseIsoTimestamp, parsePullRequestNumber, parseRepoRelativePath, parseWorkspaceProfileId } from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const identity = { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)) };
const headSha = must(parseGitSha("1".repeat(40)));
const at = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const sessionId = createReviewSessionId({ ...identity, headSha });
const snapshot: ReviewRemoteSnapshot = { schemaVersion: 1, pullRequest: { ref: { host: identity.host, owner: identity.owner, repo: identity.repo, number: identity.prNumber }, headSha, isDraft: false, isOpen: true, title: "Fixture", author: "fixture", headBranch: "main", baseBranch: "sit", reviewState: "none", mergeability: "mergeable", labels: [], updatedAt: at }, comments: { threads: [], complete: true }, commits: [], checks: { overall: "passing", checks: [] } };
const review: Review = { ...createReview({ identity, currentSessionId: sessionId, headSha, createdAt: at }), representedRemote: { headSha, pullRequestUpdatedAt: at, snapshotHash: hashSnapshot(snapshot), refreshedAt: at } };

describe("ReviewRefreshService", () => {
  it("rejects a refresh when the current session is missing before writing a candidate", async () => {
    const saveCandidate = vi.fn(async () => ok({ snapshotHash: hashSnapshot(snapshot) }));
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save() { return ok(undefined); } },
      sessions: { async load() { return { _tag: "err", error: { _tag: "StorageFailure", operation: "read", reason: "not_found" } } as never; }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, saveCandidate },
      github: { async getPullRequest() { return ok(snapshot.pullRequest); }, async getPullRequestChecks() { return ok(snapshot.checks); }, async getPullRequestComments() { return ok(snapshot.comments); }, async getPullRequestCommits() { return ok([]); }, async getMergePolicy() { return ok({} as never); } },
      preparation: { async prepare() { return ok({} as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.refresh({ profileId, reviewId: review.id })).resolves.toEqual({ _tag: "err", error: { reason: "not_found" } });
    expect(saveCandidate).not.toHaveBeenCalled();
  });

  it("rejects a refresh when the current session head no longer matches the Review", async () => {
    const mismatchedHead = must(parseGitSha("9".repeat(40)));
    const saveCandidate = vi.fn(async () => ok({ snapshotHash: hashSnapshot(snapshot) }));
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save() { return ok(undefined); } },
      sessions: { async load() { return ok({ id: sessionId, key: { ...identity, headSha: mismatchedHead } } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, saveCandidate },
      github: { async getPullRequest() { return ok(snapshot.pullRequest); }, async getPullRequestChecks() { return ok(snapshot.checks); }, async getPullRequestComments() { return ok(snapshot.comments); }, async getPullRequestCommits() { return ok([]); }, async getMergePolicy() { return ok({} as never); } },
      preparation: { async prepare() { return ok({} as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.refresh({ profileId, reviewId: review.id })).resolves.toEqual({ _tag: "err", error: { reason: "head_changed" } });
    expect(saveCandidate).not.toHaveBeenCalled();
  });

  it("keeps an open merge outcome open instead of terminalizing the Review", async () => {
    const saved: Review[] = [];
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save(value) { saved.push(value as Review); return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(snapshot) }); } },
      github: {
        async getPullRequest() { return ok({ ...snapshot.pullRequest, isOpen: false }); },
        async getPullRequestChecks() { return ok(snapshot.checks); },
        async getPullRequestComments() { return ok(snapshot.comments); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({} as never); },
        async getMergeOutcome() { return ok({ state: "open" }); },
      },
      preparation: { async prepare() { return ok({ session: { id: sessionId, key: { headSha } } } as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.refresh({ profileId, reviewId: review.id })).resolves.toMatchObject({ _tag: "ok" });
    expect(saved.at(-1)?.status).toEqual({ _tag: "Open" });
  });

  it("rejects a prepared session whose head raced beyond the fetched snapshot", async () => {
    const saves: unknown[] = [];
    const nextHead = must(parseGitSha("2".repeat(40)));
    const racedHead = must(parseGitSha("3".repeat(40)));
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save(value) { saves.push(value); return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot({ ...snapshot, pullRequest: { ...snapshot.pullRequest, headSha: nextHead } }) }); } },
      github: {
        async getPullRequest() { return ok({ ...snapshot.pullRequest, headSha: nextHead }); },
        async getPullRequestChecks() { return ok(snapshot.checks); },
        async getPullRequestComments() { return ok(snapshot.comments); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({} as never); },
      },
      preparation: { async prepare() { return ok({ session: { key: { headSha: racedHead } } } as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.refresh({ profileId, reviewId: review.id })).resolves.toEqual({ _tag: "err", error: { reason: "head_changed" } });
    expect(saves).toEqual([]);
  });

  it("marks a changed head even when old-head checks are unavailable", async () => {
    const nextHead = must(parseGitSha("2".repeat(40)));
    const save = vi.fn(async () => ok(undefined));
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, save },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(snapshot) }); } },
      github: {
        async getPullRequest() { return ok({ ...snapshot.pullRequest, headSha: nextHead }); },
        async getPullRequestChecks() { return { _tag: "err", error: { _tag: "GitHubReadFailure" } } as never; },
        async getPullRequestComments() { return ok(snapshot.comments); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({} as never); },
      },
      preparation: { async prepare() { return ok({} as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.detect({ profileId, reviewId: review.id })).resolves.toEqual({ _tag: "ok", value: { updatesAvailable: true, detectedAt: "2026-08-01T00:10:00.000Z" } });
    expect(save).toHaveBeenCalledOnce();
  });

  it("persists optional policy evidence during explicit refresh", async () => {
    let savedSnapshot: ReviewRemoteSnapshot | undefined;
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save() { return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate(input) { savedSnapshot = input.snapshot; return ok({ snapshotHash: hashSnapshot(input.snapshot) }); } },
      github: {
        async getPullRequest() { return ok(snapshot.pullRequest); },
        async getPullRequestChecks() { return ok(snapshot.checks); },
        async getPullRequestComments() { return ok(snapshot.comments); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({ pr: { host: identity.host, owner: identity.owner, repo: identity.repo, number: identity.prNumber }, headSha, isOpen: true, isDraft: false, mergeability: "blocked", mergeStateStatus: "blocked", reviewDecision: "review_required", checks: snapshot.checks, complete: true }); },
        async getMergePolicyEvidence() { return ok({ branchProtection: { state: "available", value: { requiredApprovingReviewCount: 1 } }, appliedRuleset: { state: "unavailable", reason: "forbidden" } }); },
      },
      preparation: { async prepare() { return ok({ session: { id: sessionId, key: { headSha } } } as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.refresh({ profileId, reviewId: review.id })).resolves.toMatchObject({ _tag: "ok" });
    expect(savedSnapshot?.mergeEvidence?.policy?.branchProtection).toEqual({ state: "available", value: { requiredApprovingReviewCount: 1 } });
  });

  it("flattens a projected refresh result instead of nesting the Result envelope", async () => {
    const projection = { state: "review", review: { id: review.id, status: "open" } } as never;
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save() { return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(snapshot) }); } },
      github: { async getPullRequest() { return ok(snapshot.pullRequest); }, async getPullRequestChecks() { return ok(snapshot.checks); }, async getPullRequestComments() { return ok(snapshot.comments); }, async getPullRequestCommits() { return ok([]); }, async getMergePolicy() { return ok({} as never); } },
      preparation: { async prepare() { return ok({ session: { id: sessionId, key: { headSha } } } as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
      project: async () => ok(projection),
    });
    const refreshed = await service.refresh({ profileId, reviewId: review.id });
    expect(refreshed).toEqual({ _tag: "ok", value: projection });
  });

  it("maps a projection failure after persistence without returning a nested success", async () => {
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save() { return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(snapshot) }); } },
      github: { async getPullRequest() { return ok(snapshot.pullRequest); }, async getPullRequestChecks() { return ok(snapshot.checks); }, async getPullRequestComments() { return ok(snapshot.comments); }, async getPullRequestCommits() { return ok([]); }, async getMergePolicy() { return ok({} as never); } },
      preparation: { async prepare() { return ok({ session: { id: sessionId, key: { headSha } } } as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
      project: async () => ({ _tag: "err", error: { _tag: "SessionStorageUnavailable" } }),
    });
    await expect(service.refresh({ profileId, reviewId: review.id })).resolves.toEqual({ _tag: "err", error: { reason: "storage" } });
  });

  it("persists merged rather than closed from authoritative GitHub outcome", async () => {
    const saved: Review[] = [];
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save(value) { saved.push(value as Review); return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(snapshot) }); } },
      github: {
        async getPullRequest() { return ok({ ...snapshot.pullRequest, isOpen: false }); },
        async getPullRequestChecks() { return ok(snapshot.checks); },
        async getPullRequestComments() { return ok(snapshot.comments); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({} as never); },
        async getMergeOutcome() { return ok({ state: "merged", mergedAt: at }); },
      },
      preparation: { async prepare() { return ok({ session: { id: sessionId, key: { headSha } } } as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    const refreshed = await service.refresh({ profileId, reviewId: review.id });
    expect(refreshed._tag).toBe("ok");
    expect(saved.at(-1)?.status).toEqual({ _tag: "Terminal", state: "merged", observedAt: "2026-08-01T00:10:00.000Z" });
  });

  it("does not mark a Published-feedback Review when the current reader omits optional feedback", async () => {
    const represented = { ...snapshot, publishedFeedback: { reviews: [], comments: [], complete: true } as never };
    const publishedReview: Review = { ...review, representedRemote: { headSha, pullRequestUpdatedAt: at, refreshedAt: at, snapshotHash: hashSnapshot(represented) } };
    const save = vi.fn(async () => ok(undefined));
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(publishedReview); }, save },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(represented); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(represented) }); } },
      // No published-feedback reader is available in this profile.
      github: { async getPullRequest() { return ok(snapshot.pullRequest); }, async getPullRequestChecks() { return ok(snapshot.checks); }, async getPullRequestComments() { return ok(snapshot.comments); }, async getPullRequestCommits() { return ok([]); }, async getMergePolicy() { return ok({} as never); } },
      preparation: { async prepare() { return ok({} as never); } }, now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.detect({ profileId, reviewId: publishedReview.id })).resolves.toEqual({ _tag: "ok", value: { updatesAvailable: false, detectedAt: "2026-08-01T00:10:00.000Z" } });
    expect(save).not.toHaveBeenCalled();
  });

  it("does not mark a review when only time has elapsed", async () => {
    const save = vi.fn(async () => ok(undefined));
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, save },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(snapshot) }); } },
      github: { async getPullRequest() { return ok(snapshot.pullRequest); }, async getPullRequestChecks() { return ok(snapshot.checks); }, async getPullRequestComments() { return ok(snapshot.comments); }, async getPullRequestCommits() { return ok([]); }, async getMergePolicy() { return ok({} as never); } },
      preparation: { async prepare() { return ok({} as never); } }, now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.detect({ profileId, reviewId: review.id })).resolves.toEqual({ _tag: "ok", value: { updatesAvailable: false, detectedAt: "2026-08-01T00:10:00.000Z" } });
    expect(save).not.toHaveBeenCalled();
  });

  it("heals a phantom detection flag when GitHub's updatedAt lags the snapshot content", async () => {
    // GitHub's pullRequest.updatedAt lagged comment creation during the
    // represented refresh, so the record's marker predates content the
    // snapshot already holds and a previous detect pass flagged an update.
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const detectedAt = must(parseIsoTimestamp("2026-08-01T00:06:00.000Z"));
    const represented = { ...snapshot, comments: { threads: [{ id: must(parseGitHubThreadId("t")), state: "open" as const, comments: [{ id: "c", author: "pmquan2", body: "test", createdAt: commentAt, updatedAt: commentAt, url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1", location: { path: must(parseRepoRelativePath("a.go")), line: 1, lineEnd: 1, diffSide: "new" as const } }] }], complete: true } };
    const markedReview: Review = { ...review, representedRemote: { headSha, pullRequestUpdatedAt: at, refreshedAt: at, snapshotHash: hashSnapshot(represented) }, detectedUpdate: { detectedAt, reason: "pull_request" } };
    const saved: Review[] = [];
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(markedReview); }, async save(value) { saved.push(value as Review); return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(represented); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(represented) }); } },
      github: {
        async getPullRequest() { return ok({ ...represented.pullRequest, updatedAt: commentAt }); },
        async getPullRequestChecks() { return ok(snapshot.checks); },
        // The live reader now resolves viewerDidAuthor for the same comment the
        // stored snapshot captured without it under GitHub propagation lag.
        async getPullRequestComments() { return ok({ ...represented.comments, threads: represented.comments.threads.map((thread) => ({ ...thread, comments: thread.comments.map((comment) => ({ ...comment, viewerDidAuthor: true })) })) }); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({} as never); },
      },
      preparation: { async prepare() { return ok({} as never); } }, now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.detect({ profileId, reviewId: markedReview.id })).resolves.toEqual({ _tag: "ok", value: { updatesAvailable: false, detectedAt: "2026-08-01T00:10:00.000Z" } });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.detectedUpdate).toBeUndefined();
    expect(saved[0]?.representedRemote?.pullRequestUpdatedAt).toBe(commentAt);
  });

  it("does not save again when a healed review is re-detected unchanged", async () => {
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const represented = { ...snapshot, comments: { threads: [{ id: must(parseGitHubThreadId("t")), state: "open" as const, comments: [{ id: "c", author: "pmquan2", body: "test", createdAt: commentAt, updatedAt: commentAt, url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1", location: { path: must(parseRepoRelativePath("a.go")), line: 1, lineEnd: 1, diffSide: "new" as const } }] }], complete: true } };
    const healedReview: Review = { ...review, representedRemote: { headSha, pullRequestUpdatedAt: commentAt, refreshedAt: at, snapshotHash: hashSnapshot(represented) } };
    const save = vi.fn(async () => ok(undefined));
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(healedReview); }, save },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(represented); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(represented) }); } },
      github: {
        async getPullRequest() { return ok({ ...represented.pullRequest, updatedAt: commentAt }); },
        async getPullRequestChecks() { return ok(snapshot.checks); },
        async getPullRequestComments() { return ok(represented.comments); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({} as never); },
      },
      preparation: { async prepare() { return ok({} as never); } }, now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.detect({ profileId, reviewId: healedReview.id })).resolves.toEqual({ _tag: "ok", value: { updatesAvailable: false, detectedAt: "2026-08-01T00:10:00.000Z" } });
    expect(save).not.toHaveBeenCalled();
  });

  it("marks a real new comment as an update and does not re-save the same reason", async () => {
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const changed = { ...snapshot, comments: { threads: [{ id: must(parseGitHubThreadId("t")), state: "open" as const, comments: [{ id: "c", author: "pmquan2", body: "new", createdAt: commentAt, updatedAt: commentAt, url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1", location: { path: must(parseRepoRelativePath("a.go")), line: 1, lineEnd: 1, diffSide: "new" as const } }] }], complete: true } };
    const firstSave = vi.fn(async () => ok(undefined));
    let marked: Review = { ...review, detectedUpdate: { detectedAt: "2026-08-01T00:07:00.000Z" as never, reason: "checks" } };
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(marked); }, async save(value) { marked = value as Review; return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(snapshot) }); } },
      github: {
        async getPullRequest() { return ok(snapshot.pullRequest); },
        async getPullRequestChecks() { return ok(snapshot.checks); },
        async getPullRequestComments() { return ok(changed.comments); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({} as never); },
      },
      preparation: { async prepare() { return ok({} as never); } }, now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.detect({ profileId, reviewId: marked.id })).resolves.toEqual({ _tag: "ok", value: { updatesAvailable: true, detectedAt: "2026-08-01T00:07:00.000Z" } });
    expect(firstSave).not.toHaveBeenCalled();
  });

  it("records the derived comment moment when refresh observes lagging PR updatedAt", async () => {
    const commentAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
    const lagging = { ...snapshot, pullRequest: { ...snapshot.pullRequest, updatedAt: at } };
    const withComment = { ...snapshot, comments: { threads: [{ id: must(parseGitHubThreadId("t")), state: "open" as const, comments: [{ id: "c", author: "pmquan2", body: "test", createdAt: commentAt, updatedAt: commentAt, url: "https://github.com/centraldigital/patchdesk/pull/42#discussion_r1", location: { path: must(parseRepoRelativePath("a.go")), line: 1, lineEnd: 1, diffSide: "new" as const } }] }], complete: true } };
    const saved: Review[] = [];
    const service = new ReviewRefreshService({
      profiles: { async load() { return ok({} as never); } },
      reviews: { async load() { return ok(review); }, async save(value) { saved.push(value as Review); return ok(undefined); } },
      sessions: { async load() { return ok({ key: { ...identity, headSha }, id: sessionId } as never); }, async save() { return ok(undefined); } },
      remote: { async load() { return ok(snapshot); }, async saveCandidate() { return ok({ snapshotHash: hashSnapshot(withComment) }); } },
      github: {
        async getPullRequest() { return ok(lagging.pullRequest); },
        async getPullRequestChecks() { return ok(snapshot.checks); },
        async getPullRequestComments() { return ok(withComment.comments); },
        async getPullRequestCommits() { return ok([]); },
        async getMergePolicy() { return ok({} as never); },
      },
      preparation: { async prepare() { return ok({ session: { id: sessionId, key: { headSha } } } as never); } },
      now: () => "2026-08-01T00:10:00.000Z" as never,
    });
    await expect(service.refresh({ profileId, reviewId: review.id })).resolves.toMatchObject({ _tag: "ok" });
    expect(saved.at(-1)?.representedRemote?.pullRequestUpdatedAt).toBe(commentAt);
  });
});
