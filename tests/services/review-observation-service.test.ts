import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { RecentWriteJournalStore } from "../../src/adapters/storage/recent-write-journal-store";
import { ReviewObservationJournalStore } from "../../src/adapters/storage/review-observation-journal-store";
import {
  ReviewRemoteStore,
  hashSnapshot,
  type ReviewRemoteSnapshot,
} from "../../src/adapters/storage/review-remote-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import {
  createReview,
  moveReviewToSession,
  type Review,
} from "../../src/domain/review";
import { createReviewSession } from "../../src/domain/review-session";
import {
  createPendingReviewRequestId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  type IsoTimestamp,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  ReviewObservationService,
  type ReviewObservationDependencies,
} from "../../src/services/review-observation-service";

const roots: string[] = [];
const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const identity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
const headSha = must(parseGitSha("1".repeat(40)));
const baseSha = must(parseGitSha("0".repeat(40)));
const at = must(parseIsoTimestamp("2026-08-12T00:00:00.000Z"));
const observedAt = must(parseIsoTimestamp("2026-08-12T00:01:00.000Z"));
const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    readonly terminal?: boolean;
    readonly locked?: boolean;
    readonly failReviewSave?: boolean;
    readonly failJournalRemove?: boolean;
    readonly project?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-observation-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profiles = new ProfileStore(paths);
  const profile = must(
    parseWorkspaceProfileConfig({
      id: "cfw",
      label: "CFW",
      githubHost: "github.com",
      ghAccount: "fixture",
      ownerFilters: [],
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    }),
  );
  await profiles.save(profile);
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const remote = new ReviewRemoteStore(paths);
  const session = createReviewSession({
    key: { ...identity, headSha },
    pr: { headSha, baseSha, isDraft: false, isOpen: true },
    patchPath: must(
      (await import("../../src/domain/ids")).parseAbsolutePath(
        // SAFETY: this literal is only used as a stable path segment for the
        // fixture's temp directory, never validated as a real session id.
        paths.patchFile(profileId, "session" as never),
      ),
    ),
    worktree: {
      path: must(
        (await import("../../src/domain/ids")).parseAbsolutePath(
          // SAFETY: this literal is only used as a stable path segment for
          // the fixture's temp directory, never validated as a real session id.
          paths.worktreeDirectory(profileId, "session" as never),
        ),
      ),
      headSha,
    },
    createdAt: at,
  });
  await mkdir(join(session.patchPath, ".."), { recursive: true });
  await writeFile(session.patchPath, patch, "utf8");
  const storedSession =
    options.locked === true
      ? {
          ...session,
          pendingReview: {
            _tag: "WriteInFlight" as const,
            operation: {
              _tag: "Start" as const,
              requestId: createPendingReviewRequestId(at),
            },
            startedAt: at,
          },
        }
      : session;
  await sessions.save(storedSession);
  const oldSnapshot = snapshot({ title: "old" });
  const oldCandidate = await remote.saveCandidate({
    profileId,
    reviewId: createReview({
      identity,
      currentSessionId: session.id,
      headSha,
      createdAt: at,
    }).id,
    snapshot: oldSnapshot,
  });
  if (oldCandidate._tag === "err") throw new Error("fixture");
  const created = createReview({
    identity,
    currentSessionId: session.id,
    headSha,
    createdAt: at,
  });
  const review = must(
    moveReviewToSession(created, {
      sessionId: session.id,
      headSha,
      representedRemote: {
        headSha,
        snapshotHash: oldCandidate.value.snapshotHash,
        pullRequestUpdatedAt: at,
        refreshedAt: at,
      },
      updatedAt: at,
    }),
  );
  await reviews.save(review);
  const github = fakeGitHub({ terminal: options.terminal === true });
  let failed = options.failReviewSave === true;
  const journals = new ReviewObservationJournalStore(paths);
  const recentWrites = new RecentWriteJournalStore(paths);
  let removeFailed = options.failJournalRemove === true;
  const observationDependencies = {
    profiles,
    reviews:
      options.failReviewSave === true
        ? {
            load: reviews.load.bind(reviews),
            async save(value: Review, expected?: IsoTimestamp) {
              if (failed) {
                failed = false;
                return {
                  _tag: "err" as const,
                  error: {
                    _tag: "StorageFailure" as const,
                    operation: "write" as const,
                    reason: "io" as const,
                  },
                };
              }
              return reviews.save(value, expected);
            },
          }
        : reviews,
    sessions,
    remote,
    journals:
      options.failJournalRemove === true
        ? {
            load: journals.load.bind(journals),
            save: journals.save.bind(journals),
            async remove(
              profileId: typeof identity.profileId,
              reviewId: typeof review.id,
            ) {
              if (removeFailed) {
                removeFailed = false;
                return {
                  _tag: "err" as const,
                  error: {
                    _tag: "StorageFailure" as const,
                    operation: "write" as const,
                    reason: "io" as const,
                  },
                };
              }
              return journals.remove(profileId, reviewId);
            },
          }
        : journals,
    github,
    pendingReview: {
      adoptObservedState(
        input: Parameters<
          ReviewObservationDependencies["pendingReview"]["adoptObservedState"]
        >[0],
      ) {
        const current = input.session.pendingReview ?? {
          _tag: "None" as const,
        };
        if (
          current._tag === "WriteInFlight" ||
          current._tag === "OutcomeUnknown"
        )
          return { pendingReview: current };
        return {
          pendingReview:
            input.observed._tag === "Pending"
              ? { _tag: "Pending" as const, review: input.observed.review }
              : { _tag: "None" as const },
        };
      },
    },
    recentWrites,
    coordinator: new ReviewOperationCoordinator(),
    now: () => observedAt,
  };
  const observation = new ReviewObservationService(
    options.project === true
      ? {
          ...observationDependencies,
          // SAFETY: this projection stub's return shape is opaque to the
          // service and only asserted on by tests that opt into it via
          // `options.project`.
          project: async () => ok({ state: "review" } as never),
        }
      : observationDependencies,
  );
  return {
    paths,
    sessions,
    reviews,
    remote,
    review,
    session: storedSession,
    observation,
    journals,
    recentWrites,
  };
}

function snapshot(input: {
  readonly title: string;
  readonly conversation?: ReviewRemoteSnapshot["conversation"];
}): ReviewRemoteSnapshot {
  return {
    schemaVersion: 1,
    pullRequest: {
      ref: {
        host: identity.host,
        owner: identity.owner,
        repo: identity.repo,
        number: identity.prNumber,
      },
      headSha,
      baseSha,
      isDraft: false,
      isOpen: true,
      title: input.title,
      author: "fixture",
      headBranch: "feature",
      baseBranch: "main",
      reviewState: "none",
      mergeability: "mergeable",
      labels: [],
      changedFileCount: 1,
      updatedAt: observedAt,
    },
    comments: { threads: [], complete: true },
    commits: [],
    checks: { overall: "passing", checks: [] },
    conversation: input.conversation ?? { prDescription: "", entries: [] },
  };
}

function fakeGitHub(input: { readonly terminal: boolean }) {
  const current = {
    ...snapshot({ title: "new" }).pullRequest,
    isOpen: !input.terminal,
  };
  return {
    async getPullRequest() {
      return ok(current);
    },
    async getPullRequestDiff() {
      return ok(patch);
    },
    async getPullRequestComments() {
      return ok({ threads: [], complete: true });
    },
    async getPullRequestChecks() {
      return ok({ overall: "passing" as const, checks: [] });
    },
    async getMergePolicy() {
      return ok({
        pr: current.ref,
        headSha,
        isOpen: !input.terminal,
        isDraft: false,
        mergeability: "mergeable" as const,
        reviewDecision: "approved" as const,
        checks: { overall: "passing" as const, checks: [] },
        complete: true,
      });
    },
    async loadConversation() {
      return ok({
        prDescription: "current description",
        entries: [
          { _tag: "PrDescription" as const, body: "current description" },
        ],
        complete: true,
      });
    },
    async resolveAuthenticatedAccount() {
      return ok({ host: identity.host, account: "fixture" });
    },
    async getViewerPendingReview() {
      return ok({ _tag: "None" as const });
    },
    async getPullRequestPublishedFeedback() {
      return ok({ reviews: [], comments: [], complete: true });
    },
    async getMergeOutcome() {
      return ok(
        input.terminal
          ? { state: "closed_unmerged" as const }
          : { state: "open" as const },
      );
    },
  };
}

describe("ReviewObservationService", () => {
  it("durably adopts same-revision metadata and Conversation only after canonical proof", async () => {
    const value = await fixture();
    await expect(
      value.observation.observe({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({ _tag: "ok", value: { _tag: "Reconciled" } });
    const review = await value.reviews.load(profileId, value.review.id);
    expect(review).toMatchObject({
      _tag: "ok",
      value: { freshness: { _tag: "Fresh" } },
    });
    if (review._tag === "ok") {
      expect(review.value.representedRemote?.snapshotHash).not.toBe(
        hashSnapshot(snapshot({ title: "old" })),
      );
      const snapshotHash = review.value.representedRemote?.snapshotHash;
      if (snapshotHash === undefined) throw new Error("missing snapshot");
      const remote = await value.remote.load({
        profileId,
        reviewId: value.review.id,
        snapshotHash,
      });
      expect(remote).toMatchObject({
        _tag: "ok",
        value: {
          pullRequest: { title: "new" },
          conversation: { prDescription: "current description" },
        },
      });
    }
    await expect(
      new ReviewObservationJournalStore(value.paths).load(
        profileId,
        value.review.id,
      ),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });
  it("retains a confirmed-write journal until the durable candidate contains its receipt", async () => {
    const value = await fixture({ project: true });
    const pendingPropagation = await value.observation.observe({
      profileId,
      reviewId: value.review.id,
      recentWrites: [{ _tag: "Comment", commentId: "not-visible-yet" }],
    });
    expect(pendingPropagation).toMatchObject({
      _tag: "ok",
      value: { _tag: "Reconciled" },
    });
    if (
      pendingPropagation._tag === "ok" &&
      pendingPropagation.value._tag === "Reconciled"
    ) {
      expect(pendingPropagation.value.projection).toBeUndefined();
    }
    const propagated = await value.observation.observe({
      profileId,
      reviewId: value.review.id,
    });
    expect(propagated).toMatchObject({
      _tag: "ok",
      value: { _tag: "Reconciled", projection: { state: "review" } },
    });
  });

  it("replays a journal left by a failed Review save without exposing a mixed state", async () => {
    const value = await fixture({ failReviewSave: true });
    await expect(
      value.observation.observe({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Unavailable", reason: "reconciliation_incomplete" },
    });
    await expect(
      value.reviews.load(profileId, value.review.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        freshness: { _tag: "Unavailable", reason: "reconciliation_incomplete" },
      },
    });
    const replay = new ReviewObservationService({
      profiles: new ProfileStore(value.paths),
      reviews: value.reviews,
      sessions: value.sessions,
      remote: value.remote,
      journals: new ReviewObservationJournalStore(value.paths),
      recentWrites: new RecentWriteJournalStore(value.paths),
      github: fakeGitHub({ terminal: false }),
      pendingReview: {
        adoptObservedState() {
          return { pendingReview: { _tag: "None" as const } };
        },
      },
      coordinator: new ReviewOperationCoordinator(),
      now: () => observedAt,
    });
    await expect(
      replay.recover({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({ _tag: "ok", value: { _tag: "Reconciled" } });
    await expect(
      new ReviewObservationJournalStore(value.paths).load(
        profileId,
        value.review.id,
      ),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });

  it("preserves a later explicit pending-review resolution while replaying an older journal", async () => {
    const value = await fixture({ failReviewSave: true });
    await value.observation.observe({ profileId, reviewId: value.review.id });
    const loaded = await value.sessions.load(profileId, value.session.id);
    if (loaded._tag === "err") throw new Error("fixture");
    await value.sessions.save(
      {
        ...loaded.value,
        pendingReview: { _tag: "None" },
        // SAFETY: this literal is a well-formed ISO 8601 instant.
        updatedAt: "2026-08-11T00:00:03.000Z" as IsoTimestamp,
      },
      loaded.value.updatedAt,
    );

    const replay = new ReviewObservationService({
      profiles: new ProfileStore(value.paths),
      reviews: value.reviews,
      sessions: value.sessions,
      remote: value.remote,
      journals: value.journals,
      recentWrites: value.recentWrites,
      github: fakeGitHub({ terminal: false }),
      pendingReview: {
        adoptObservedState() {
          return { pendingReview: { _tag: "None" as const } };
        },
      },
      coordinator: new ReviewOperationCoordinator(),
      // SAFETY: this literal is a well-formed ISO 8601 instant.
      now: () => "2026-08-11T00:00:04.000Z" as IsoTimestamp,
    });
    await expect(
      replay.recover({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Reconciled" },
    });
    await expect(
      value.sessions.load(profileId, value.session.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { pendingReview: { _tag: "None" } },
    });
    await expect(
      value.journals.load(profileId, value.review.id),
    ).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
  });

  it("recovers when journal cleanup failed after both adoptions completed", async () => {
    const value = await fixture({ failJournalRemove: true });
    await expect(
      value.observation.observe({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Unavailable", reason: "reconciliation_incomplete" },
    });
    await expect(
      value.reviews.load(profileId, value.review.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { freshness: { _tag: "Unavailable" } },
    });

    await expect(
      value.observation.recover({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({ _tag: "ok", value: { _tag: "Reconciled" } });
    await expect(
      value.reviews.load(profileId, value.review.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { freshness: { _tag: "Fresh" } },
    });
    await expect(
      value.journals.load(profileId, value.review.id),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });

  it("marks an incomplete journal unavailable", async () => {
    const value = await fixture();
    await writeFile(
      value.paths.reviewObservationJournalFile(profileId, value.review.id),
      "{}",
      "utf8",
    );
    await expect(
      value.observation.recover({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Unavailable", reason: "reconciliation_incomplete" },
    });
  });

  it("marks a conflicting journal unavailable instead of mixing candidate state", async () => {
    const value = await fixture();
    const candidate = await value.remote.saveCandidate({
      profileId,
      reviewId: value.review.id,
      snapshot: snapshot({ title: "candidate" }),
    });
    if (candidate._tag === "err") throw new Error("fixture");
    const journals = new ReviewObservationJournalStore(value.paths);
    // SAFETY: expectedSessionUpdatedAt/nextSessionUpdatedAt below are
    // well-formed ISO 8601 instants, each later than the previous,
    // satisfying the journal's ordering invariant.
    await journals.save({
      schemaVersion: 1,
      profileId,
      reviewId: value.review.id,
      sessionId: value.session.id,
      sessionHeadSha: headSha,
      expectedReviewUpdatedAt: at,
      expectedSessionUpdatedAt: "2026-08-11T00:00:00.000Z" as IsoTimestamp,
      nextSessionUpdatedAt: "2026-08-11T00:00:01.000Z" as IsoTimestamp,
      nextReviewUpdatedAt: observedAt,
      previousSnapshotHash:
        value.review.representedRemote?.snapshotHash ??
        candidate.value.snapshotHash,
      nextSnapshotHash: candidate.value.snapshotHash,
      nextPendingReview: { _tag: "None" },
      createdAt: observedAt,
    });
    await expect(
      value.observation.recover({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Unavailable", reason: "reconciliation_incomplete" },
    });
  });

  it("gives terminal state precedence without adopting changed remote metadata", async () => {
    const value = await fixture({ terminal: true });
    await expect(
      value.observation.observe({ profileId, reviewId: value.review.id }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Terminal", status: "closed" },
    });
    await expect(
      value.reviews.load(profileId, value.review.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        status: { _tag: "Terminal", state: "closed" },
        representedRemote: {
          snapshotHash: value.review.representedRemote?.snapshotHash,
        },
      },
    });
  });

  it("retains a locked pending draft during an ordinary observation", async () => {
    const value = await fixture({ locked: true });
    await value.observation.observe({ profileId, reviewId: value.review.id });
    await expect(
      value.sessions.load(profileId, value.session.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { pendingReview: { _tag: "WriteInFlight" } },
    });
  });
});
