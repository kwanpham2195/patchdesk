import type { GitHubReader } from "../../src/adapters/github/github-adapter";
import { ReviewRefreshService } from "../../src/services/review-refresh-service";
import {
  hashSnapshot,
  type ReviewRemoteSnapshot,
} from "../../src/adapters/storage/review-remote-store";
import {
  createReview,
  parseReview,
  type Review,
  type ReviewIdentity,
} from "../../src/domain/review";
import type {
  MergePolicySnapshot,
  PullRequestSummary,
} from "../../src/domain/github-context";
import {
  createReviewSession,
  type ReviewSession,
} from "../../src/domain/review-session";
import {
  parseAbsolutePath,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  type GitSha,
  type IsoTimestamp,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { parseStoredReviewSession } from "../../src/adapters/storage/review-session-store";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import type {
  RecentReviewWrite,
  ReviewRefreshDependencies,
} from "../../src/services/review-refresh-service";
import type { ReviewWorkbenchProjection } from "../../src/services/review-workbench-projection";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

/** Parsed values shared by every ReviewRefreshService scenario. */
export type ReviewRefreshFixtureValues = {
  readonly profileId: WorkspaceProfileId;
  readonly profile: WorkspaceProfileConfig;
  readonly identity: ReviewIdentity;
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
  readonly at: IsoTimestamp;
  readonly sessionId: ReviewSessionId;
  readonly snapshot: ReviewRemoteSnapshot;
  readonly session: ReviewSession;
  readonly review: Review;
};

type PullRequestResult = Awaited<ReturnType<GitHubReader["getPullRequest"]>>;
type SessionLoadResult = Awaited<
  ReturnType<ReviewRefreshDependencies["sessions"]["load"]>
>;
type ChecksResult = Awaited<
  ReturnType<ReviewRefreshDependencies["github"]["getPullRequestChecks"]>
>;
type CommentsResult = Awaited<
  ReturnType<ReviewRefreshDependencies["github"]["getPullRequestComments"]>
>;
type CommitsResult = Awaited<
  ReturnType<ReviewRefreshDependencies["github"]["getPullRequestCommits"]>
>;
type ConversationResult = Awaited<
  ReturnType<ReviewRefreshDependencies["github"]["loadConversation"]>
>;
type MergePolicyResult = Awaited<
  ReturnType<ReviewRefreshDependencies["github"]["getMergePolicy"]>
>;
type MergePolicyEvidenceResult = Awaited<
  ReturnType<
    NonNullable<ReviewRefreshDependencies["github"]["getMergePolicyEvidence"]>
  >
>;
type MergeOutcomeResult = Awaited<
  ReturnType<
    NonNullable<ReviewRefreshDependencies["github"]["getMergeOutcome"]>
  >
>;
type PublishedFeedbackResult = Awaited<
  ReturnType<
    NonNullable<
      ReviewRefreshDependencies["github"]["getPullRequestPublishedFeedback"]
    >
  >
>;

type MutableReviewRefreshDependencies = {
  -readonly [
    K in keyof ReviewRefreshDependencies
  ]: ReviewRefreshDependencies[K];
};

/** Named behavior overrides for the shared refresh dependency graph. */
export type ReviewRefreshFixtureOptions = {
  readonly review?: Review;
  readonly representedSnapshot?: ReviewRemoteSnapshot;
  readonly session?: ReviewSession;
  readonly sessionLoad?: SessionLoadResult;
  readonly currentPullRequest?: PullRequestSummary;
  readonly pullRequestResults?: ReadonlyArray<PullRequestResult>;
  readonly checksResult?: ChecksResult;
  readonly commentsResult?: CommentsResult;
  readonly commitsResult?: CommitsResult;
  readonly conversationResult?: ConversationResult;
  readonly mergePolicyResult?: MergePolicyResult;
  readonly mergePolicyEvidenceResult?: MergePolicyEvidenceResult;
  readonly mergeOutcomeResult?: MergeOutcomeResult;
  readonly publishedFeedbackResult?: PublishedFeedbackResult;
  readonly preparedSession?: ReviewSession;
  readonly recentWrites?: ReadonlyArray<RecentReviewWrite>;
  readonly projectionOutcome?: "success" | "failure";
  readonly avatarSyncFailure?: boolean;
  readonly now?: IsoTimestamp;
};

/** Recording seams owned by the refresh fixture. */
export type ReviewRefreshFixtureCalls = {
  readonly savedCandidates: Array<ReviewRemoteSnapshot>;
  readonly savedReviews: Array<Review>;
  readonly savedSessions: Array<ReviewSession>;
  readonly preparations: Array<"prepare">;
  readonly projections: Array<"project">;
  readonly avatarSyncs: Array<"syncCommentAuthors">;
  readonly clearedRecentWrites: Array<{
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: Review["id"];
  }>;
};

/** Create parsed, valid domain values for one refresh test. */
export function createReviewRefreshFixtureValues(): ReviewRefreshFixtureValues {
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const identity = {
    profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("centraldigital")),
    repo: must(parseGitHubRepoName("patchdesk")),
    prNumber: must(parsePullRequestNumber(42)),
  } satisfies ReviewIdentity;
  const headSha = must(parseGitSha("1".repeat(40)));
  const baseSha = must(parseGitSha("b".repeat(40)));
  const at = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
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
      baseSha,
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
  const session = createReviewRefreshSession({
    identity,
    snapshot,
    createdAt: at,
    headSha,
  });
  const review: Review = {
    ...createReview({
      identity,
      currentSessionId: session.id,
      headSha,
      createdAt: at,
    }),
    representedRemote: {
      headSha,
      pullRequestUpdatedAt: at,
      snapshotHash: hashSnapshot(snapshot),
      refreshedAt: at,
    },
  };
  const profile: WorkspaceProfileConfig = {
    id: profileId,
    label: "Fixture",
    githubHost: identity.host,
    ghAccount: "fixture",
    ownerFilters: [identity.owner],
    workspaceRoots: [must(parseAbsolutePath("/tmp/patchdesk-refresh"))],
    rulePaths: [],
    repos: [
      {
        host: identity.host,
        owner: identity.owner,
        repo: identity.repo,
      },
    ],
  };

  return {
    profileId,
    profile,
    identity,
    baseSha,
    headSha,
    at,
    sessionId: session.id,
    snapshot,
    session,
    review,
  };
}

/** Build a complete session for a requested head SHA. */
export function createReviewRefreshSession(input: {
  readonly identity: ReviewIdentity;
  readonly snapshot: ReviewRemoteSnapshot;
  readonly createdAt: IsoTimestamp;
  readonly headSha: GitSha;
}): ReviewSession {
  const baseSha = input.snapshot.pullRequest.baseSha;
  if (baseSha === undefined) throw new Error("Fixture snapshot needs a base");
  const key = { ...input.identity, headSha: input.headSha, baseSha };
  return createReviewSession({
    key,
    pr: {
      headSha: input.headSha,
      baseSha,
      isDraft: input.snapshot.pullRequest.isDraft,
      isOpen: input.snapshot.pullRequest.isOpen,
    },
    patchPath: must(parseAbsolutePath("/tmp/patchdesk-refresh.patch")),
    canonicalPatchHash: must(parseContentHash("a".repeat(64))),
    worktree: {
      path: must(parseAbsolutePath("/tmp/patchdesk-refresh-worktree")),
      headSha: input.headSha,
    },
    createdAt: input.createdAt,
  });
}

/** Create the shared refresh service with valid dependencies and recordings. */
export function createReviewRefreshFixture(
  options: ReviewRefreshFixtureOptions = {},
): ReviewRefreshFixtureValues & {
  readonly service: ReviewRefreshService;
  readonly calls: ReviewRefreshFixtureCalls;
} {
  const values = createReviewRefreshFixtureValues();
  const review = options.review ?? values.review;
  const representedSnapshot = options.representedSnapshot ?? values.snapshot;
  const session = options.session ?? values.session;
  const currentPullRequest =
    options.currentPullRequest ?? values.snapshot.pullRequest;
  const calls: ReviewRefreshFixtureCalls = {
    savedCandidates: [],
    savedReviews: [],
    savedSessions: [],
    preparations: [],
    projections: [],
    avatarSyncs: [],
    clearedRecentWrites: [],
  };
  const mergePolicy = createMergePolicy(values, currentPullRequest);
  const projection = createProjection(
    review,
    session,
    values,
    currentPullRequest,
  );
  let pullRequestRead = 0;
  const readPullRequest = async (): Promise<PullRequestResult> => {
    const result = options.pullRequestResults?.[pullRequestRead];
    pullRequestRead += 1;
    return result ?? ok(currentPullRequest);
  };
  const github: ReviewRefreshDependencies["github"] = {
    getPullRequest: readPullRequest,
    getPullRequestChecks: async () =>
      options.checksResult ?? ok(values.snapshot.checks),
    getPullRequestComments: async () =>
      options.commentsResult ?? ok(values.snapshot.comments),
    getPullRequestCommits: async () => options.commitsResult ?? ok([]),
    loadConversation: async () =>
      options.conversationResult ?? ok(values.snapshot.conversation),
    getMergePolicy: async () => options.mergePolicyResult ?? ok(mergePolicy),
  };
  const mergePolicyEvidenceResult = options.mergePolicyEvidenceResult;
  const mergeOutcomeResult = options.mergeOutcomeResult;
  const publishedFeedbackResult = options.publishedFeedbackResult;
  if (mergePolicyEvidenceResult !== undefined)
    github.getMergePolicyEvidence = async () => mergePolicyEvidenceResult;
  if (mergeOutcomeResult !== undefined)
    github.getMergeOutcome = async () => mergeOutcomeResult;
  if (publishedFeedbackResult !== undefined)
    github.getPullRequestPublishedFeedback = async () =>
      publishedFeedbackResult;

  const dependencies: MutableReviewRefreshDependencies = {
    profiles: { load: async () => ok(values.profile) },
    reviews: {
      load: async () => ok(review),
      save: async (saved) => {
        calls.savedReviews.push(must(parseReview(saved)));
        return ok(undefined);
      },
    },
    sessions: {
      load: async () => options.sessionLoad ?? ok(session),
      save: async (saved) => {
        calls.savedSessions.push(must(parseStoredReviewSession(saved)));
        return ok(undefined);
      },
    },
    remote: {
      load: async () => ok(representedSnapshot),
      saveCandidate: async ({ snapshot: candidate }) => {
        calls.savedCandidates.push(candidate);
        return ok({ snapshotHash: hashSnapshot(candidate) });
      },
    },
    github,
    preparation: {
      prepare: async () => {
        calls.preparations.push("prepare");
        return ok({
          session: options.preparedSession ?? session,
          disposition: "prepared" as const,
        });
      },
    },
    pendingReview: {
      reconcileWithinReviewLock: async () =>
        ok({ session, state: { _tag: "None" } as const, unavailable: false }),
    },
    operationCoordinator: new ReviewOperationCoordinator(),
    recentWrites: {
      load: async () => ok(options.recentWrites ?? []),
      clear: async (profileId, reviewId) => {
        calls.clearedRecentWrites.push({ profileId, reviewId });
        return ok(undefined);
      },
    },
    now: () =>
      options.now ?? must(parseIsoTimestamp("2026-08-01T00:10:00.000Z")),
  };
  if (options.avatarSyncFailure === true)
    dependencies.avatars = {
      syncCommentAuthors: async () => {
        calls.avatarSyncs.push("syncCommentAuthors");
        throw new Error("fixture avatar failure");
      },
    };
  if (options.projectionOutcome !== undefined)
    dependencies.project = async () => {
      calls.projections.push("project");
      return options.projectionOutcome === "success"
        ? ok(projection)
        : err({ _tag: "SessionStorageUnavailable" });
    };

  return {
    ...values,
    review,
    snapshot: representedSnapshot,
    session,
    sessionId: session.id,
    service: new ReviewRefreshService(dependencies),
    calls,
  };
}

function createMergePolicy(
  values: ReviewRefreshFixtureValues,
  currentPullRequest: PullRequestSummary,
): MergePolicySnapshot {
  return {
    pr: {
      host: values.identity.host,
      owner: values.identity.owner,
      repo: values.identity.repo,
      number: values.identity.prNumber,
    },
    headSha: currentPullRequest.headSha,
    isOpen: currentPullRequest.isOpen,
    isDraft: currentPullRequest.isDraft,
    mergeability: "mergeable",
    reviewDecision: "unknown",
    checks: values.snapshot.checks,
    complete: true,
  };
}

function createProjection(
  review: Review,
  session: ReviewSession,
  values: ReviewRefreshFixtureValues,
  currentPullRequest: PullRequestSummary,
): ReviewWorkbenchProjection {
  return {
    state: "review",
    review: {
      id: review.id,
      status: review.status._tag === "Open" ? "open" : review.status.state,
    },
    session: { id: session.id, key: session.key },
    revision: {
      reviewedHeadSha: session.key.headSha,
      freshness: "fresh",
      refreshedAt: values.at,
    },
    pullRequest: currentPullRequest,
    commits: [],
    insights: {
      analysis: { status: "not_generated" },
      walkthrough: { status: "not_generated" },
    },
    analysisReviewActions: {
      findings: {},
      canFinishWithAnalysisSummary: false,
    },
    directSummaryDecision: "unknown",
    conversation: { prDescription: "", entries: [] },
    checks: values.snapshot.checks,
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
  };
}

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}
