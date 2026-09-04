import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type {
  ReviewRemoteSnapshot,
  ReviewRemoteStore,
} from "../adapters/storage/review-remote-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  markReviewTerminal,
  moveReviewToSession,
  type Review,
} from "../domain/review";
import type { PullRequestRef } from "../domain/pull-request";
import {
  toMergeEvidence,
  type GitHubComments,
  type GitHubPublishedFeedback,
  type PullRequestSummary,
} from "../domain/github-context";
import type {
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import {
  sameReviewRevision,
  type ReviewRevision,
} from "../domain/review-session";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";
import type { ReviewSessionPreparation } from "./review-session-preparation";
import type {
  ReviewWorkbenchProjection,
  WorkbenchProjectionFailure,
} from "./review-workbench-projection";
import type { PendingReviewService } from "./pending-review-service";
import type { PendingReviewState } from "../domain/pending-review";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { AppLogService } from "./app-log-service";
import type { AvatarSyncService } from "./avatar-sync-service";

export type ReviewRefreshFailure = {
  readonly reason:
    | "invalid_input"
    | "not_found"
    | "github_read"
    | "github_auth"
    | "storage"
    | "head_changed"
    | "terminal";
};

export type ReviewRefreshDependencies = {
  readonly profiles: Pick<ProfileStore, "load">;
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly sessions: Pick<ReviewSessionStore, "load" | "save">;
  readonly remote: Pick<ReviewRemoteStore, "load" | "saveCandidate">;
  readonly github: Pick<
    GitHubReader,
    | "getPullRequest"
    | "getPullRequestComments"
    | "getPullRequestCommits"
    | "getPullRequestChecks"
    | "loadConversation"
    | "getMergePolicy"
  > &
    Partial<
      Pick<
        GitHubReader,
        | "getPullRequestDiff"
        | "getMergePolicyEvidence"
        | "getMergeOutcome"
        | "getPullRequestPublishedFeedback"
      >
    >;
  readonly preparation: Pick<ReviewSessionPreparation, "prepare">;
  readonly now: () => IsoTimestamp;
  readonly pendingReview: Pick<
    PendingReviewService,
    "reconcileWithinReviewLock"
  >;
  readonly recentWrites: Pick<RecentWriteJournalStore, "clear">;
  readonly operationCoordinator: ReviewOperationCoordinator;
  /** Local diagnostic log stream; best effort, never gates a refresh. Wire-visible failures stay collapsed to "storage" — this only makes the underlying cause observable in `patchdesk.jsonl`. */
  readonly log?: Pick<AppLogService, "write">;
  /**
   * Best-effort commenter-avatar cache warm. Absent in tests that don't care
   * about it; when present, a failure here must never fail the refresh — see
   * the try/catch around its call site in `refresh`.
   */
  readonly avatars?: Pick<AvatarSyncService, "syncCommentAuthors">;
  readonly project?: (input: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
    readonly snapshot: ReviewRemoteSnapshot;
    readonly refreshedAt: IsoTimestamp;
    readonly freshness: Review["freshness"];
    readonly pendingReview?: {
      readonly state: PendingReviewState;
      readonly unavailable: boolean;
    };
  }) => Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>>;
};

/** Applies an explicit, durable refresh of a Review from GitHub. */
export class ReviewRefreshService {
  constructor(private readonly dependencies: ReviewRefreshDependencies) {}

  async refresh(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    /** Terminal-only opening requires merged evidence at the final authoritative read. */
    readonly expectedTerminalState?: "merged";
  }): Promise<Result<unknown, ReviewRefreshFailure>> {
    return this.serialized<unknown>(input.profileId, input.reviewId, () =>
      this.refreshUnlocked(input),
    );
  }

  /** Same refresh as `refresh`, for a caller already holding `open`'s coordinator lock — retaking it here would deadlock (`withReviewLock` isn't re-entrant). */
  async refreshUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly expectedTerminalState?: "merged";
  }): Promise<Result<unknown, ReviewRefreshFailure>> {
    const loaded = await this.loadReview(input.profileId, input.reviewId);
    if (loaded._tag === "err") return loaded;
    const { review, profile } = loaded.value;
    if (review.status._tag === "Terminal") return err({ reason: "terminal" });
    const currentSession = await this.dependencies.sessions.load(
      input.profileId,
      review.currentSessionId,
    );
    if (currentSession._tag === "err") {
      return currentSession.error.reason === "not_found"
        ? err({ reason: "not_found" })
        : err({ reason: "storage" });
    }
    if (currentSession.value.id !== review.currentSessionId)
      return err({ reason: "storage" });
    if (
      currentSession.value.key.profileId !== review.identity.profileId ||
      currentSession.value.key.host !== review.identity.host ||
      currentSession.value.key.owner !== review.identity.owner ||
      currentSession.value.key.repo !== review.identity.repo ||
      currentSession.value.key.prNumber !== review.identity.prNumber
    ) {
      return err({ reason: "storage" });
    }
    if (currentSession.value.key.headSha !== review.currentHeadSha)
      return err({ reason: "head_changed" });
    const pullRequest = ref(review);
    const current = await this.dependencies.github.getPullRequest({
      profile,
      pr: pullRequest,
    });
    if (current._tag === "err") return err({ reason: "github_read" });
    if (input.expectedTerminalState === "merged" && current.value.isOpen)
      return err({ reason: "terminal" });
    const currentRevision = reviewRevisionOf(current.value);
    if (currentRevision === undefined) return err({ reason: "github_read" });
    const [
      comments,
      commits,
      checks,
      conversation,
      mergePolicy,
      publishedFeedback,
      policyEvidence,
    ] = await Promise.all([
      this.dependencies.github.getPullRequestComments({
        profile,
        pr: pullRequest,
      }),
      this.dependencies.github.getPullRequestCommits({
        profile,
        pr: pullRequest,
      }),
      this.dependencies.github.getPullRequestChecks({
        profile,
        pr: pullRequest,
        headSha: current.value.headSha,
      }),
      this.dependencies.github.loadConversation({
        profile,
        pr: pullRequest,
      }),
      this.dependencies.github.getMergePolicy({
        profile,
        pr: pullRequest,
        expectedHeadSha: current.value.headSha,
      }),
      this.dependencies.github.getPullRequestPublishedFeedback === undefined
        ? Promise.resolve(ok(undefined))
        : this.dependencies.github.getPullRequestPublishedFeedback({
            profile,
            pr: pullRequest,
          }),
      this.dependencies.github.getMergePolicyEvidence === undefined
        ? Promise.resolve(ok(undefined))
        : this.dependencies.github.getMergePolicyEvidence({
            profile,
            pr: pullRequest,
            branch: current.value.baseBranch,
          }),
    ]);
    if (
      comments._tag === "err" ||
      commits._tag === "err" ||
      checks._tag === "err" ||
      conversation._tag === "err" ||
      mergePolicy._tag === "err" ||
      publishedFeedback._tag === "err"
    )
      return err({ reason: "github_read" });
    const verified = await this.dependencies.github.getPullRequest({
      profile,
      pr: pullRequest,
    });
    if (verified._tag === "err") return err({ reason: "github_read" });
    const verifiedRevision = reviewRevisionOf(verified.value);
    if (
      verifiedRevision === undefined ||
      !sameReviewRevision(verifiedRevision, currentRevision)
    )
      return err({ reason: "head_changed" });
    if (input.expectedTerminalState === "merged" && verified.value.isOpen)
      return err({ reason: "terminal" });
    const expectedTerminal =
      input.expectedTerminalState === "merged"
        ? await this.authoritativeMergedTerminalState(profile, pullRequest)
        : undefined;
    if (expectedTerminal?._tag === "err") return expectedTerminal;
    const candidateBase = {
      schemaVersion: 1 as const,
      pullRequest: current.value,
      comments: comments.value,
      commits: commits.value,
      checks: checks.value,
      conversation: conversation.value,
      mergePolicy: mergePolicy.value,
      mergeEvidence: toMergeEvidence(
        mergePolicy.value,
        policyEvidence._tag === "ok" ? policyEvidence.value : undefined,
      ),
    };
    const candidate: ReviewRemoteSnapshot =
      publishedFeedback.value === undefined
        ? candidateBase
        : { ...candidateBase, publishedFeedback: publishedFeedback.value };
    const savedCandidate = await this.dependencies.remote.saveCandidate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      snapshot: candidate,
    });
    if (savedCandidate._tag === "err") {
      const saveFailureMeta =
        savedCandidate.error.issuePath === undefined
          ? {
              reviewId: input.reviewId,
              operation: savedCandidate.error.operation,
              reason: savedCandidate.error.reason,
            }
          : {
              reviewId: input.reviewId,
              operation: savedCandidate.error.operation,
              reason: savedCandidate.error.reason,
              issuePath: savedCandidate.error.issuePath,
            };
      this.dependencies.log?.write({
        process: "main",
        level: "error",
        topic: "review-refresh",
        message: "remote candidate save failed; reported to caller as storage",
        profileId: input.profileId,
        meta: saveFailureMeta,
      });
      return err({ reason: "storage" });
    }
    // Best effort, always: a slow, failed, or offline avatar fetch must
    // never fail this refresh. AvatarSyncService already swallows every
    // per-avatar failure internally; the try/catch here is defense in
    // depth against a misbehaving injected dependency.
    try {
      await this.dependencies.avatars?.syncCommentAuthors({
        profileId: input.profileId,
        snapshot: candidate,
      });
    } catch {
      // Decorative only; ignored.
    }
    let sessionId = review.currentSessionId;
    let selectedSession = currentSession.value;
    if (!sameReviewRevision(currentSession.value.key, currentRevision)) {
      const prepared = await this.dependencies.preparation.prepare(
        input.expectedTerminalState === undefined
          ? { profileId: input.profileId, pullRequest }
          : {
              profileId: input.profileId,
              pullRequest,
              expectedPullRequestState: "non_open",
            },
      );
      if (prepared._tag === "err")
        return mapPreparationFailure(
          prepared.error._tag,
          this.dependencies.log,
        );
      if (!sameReviewRevision(prepared.value.session.key, currentRevision))
        return err({ reason: "head_changed" });
      const persisted = await this.dependencies.sessions.save(
        prepared.value.session,
      );
      if (persisted._tag === "err") return err({ reason: "storage" });
      sessionId = prepared.value.session.id;
      selectedSession = prepared.value.session;
    }
    const representedRemote = {
      headSha: current.value.headSha,
      pullRequestUpdatedAt: latestRepresentedMoment(
        current.value,
        comments.value,
        publishedFeedback.value,
      ),
      snapshotHash: savedCandidate.value.snapshotHash,
      refreshedAt: this.dependencies.now(),
    };
    const advanced = moveReviewToSession(review, {
      sessionId,
      headSha: current.value.headSha,
      representedRemote,
      updatedAt: representedRemote.refreshedAt,
    });
    if (advanced._tag === "err") return err({ reason: "terminal" });
    const terminalState =
      expectedTerminal === undefined && !current.value.isOpen
        ? await this.authoritativeTerminalState(profile, pullRequest)
        : undefined;
    if (terminalState?._tag === "err") return err({ reason: "github_read" });
    const authoritative =
      expectedTerminal !== undefined
        ? markReviewTerminal(
            advanced.value,
            expectedTerminal.value,
            representedRemote.refreshedAt,
          )
        : terminalState?.value === undefined
          ? advanced.value
          : markReviewTerminal(
              advanced.value,
              terminalState.value,
              representedRemote.refreshedAt,
            );
    const savedReview = await this.dependencies.reviews.save(
      authoritative,
      review.updatedAt,
    );
    if (savedReview._tag === "err") return err({ reason: "storage" });
    // Best effort: an explicit refresh always fully re-baselines
    // representedRemote, so the own-write journal has nothing left to
    // protect. A clear failure must not fail the refresh itself.
    await this.dependencies.recentWrites.clear(input.profileId, input.reviewId);
    if (this.dependencies.project === undefined)
      return ok({ review: authoritative, sessionId, snapshot: candidate });
    // Explicit refresh reconciles the viewer's pending review; a failed read
    // is unavailable in the projection, never a claim that none exists.
    const reconciled =
      await this.dependencies.pendingReview.reconcileWithinReviewLock({
        profileId: input.profileId,
        reviewId: input.reviewId,
      });
    // SAFETY: `{ _tag: "None" }` is a literal, complete member of the
    // PendingReviewState union (no other fields required).
    const noPendingReview = { _tag: "None" } as PendingReviewState;
    const pendingReview = {
      state:
        reconciled._tag === "ok"
          ? reconciled.value.state
          : (selectedSession.pendingReview ?? noPendingReview),
      unavailable: reconciled._tag !== "ok" || reconciled.value.unavailable,
    };
    const projected = await this.dependencies.project({
      profileId: input.profileId,
      sessionId,
      snapshot: candidate,
      freshness: authoritative.freshness,
      refreshedAt: representedRemote.refreshedAt,
      pendingReview,
    });
    return projected._tag === "ok" ? projected : err({ reason: "storage" });
  }

  private async authoritativeTerminalState(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<
    Result<"merged" | "closed" | undefined, ReviewRefreshFailure> | undefined
  > {
    if (this.dependencies.github.getMergeOutcome === undefined)
      return ok("closed");
    const outcome = await this.dependencies.github.getMergeOutcome({
      profile,
      pr,
    });
    if (outcome._tag === "err") return err({ reason: "github_read" });
    if (outcome.value.state === "merged") return ok("merged");
    if (outcome.value.state === "closed_unmerged") return ok("closed");
    return ok(undefined);
  }

  /** Requires fresh GitHub proof of the merged terminal state for terminal-only opening. */
  private async authoritativeMergedTerminalState(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<Result<"merged", ReviewRefreshFailure>> {
    if (this.dependencies.github.getMergeOutcome === undefined)
      return err({ reason: "terminal" });
    const outcome = await this.dependencies.github.getMergeOutcome({
      profile,
      pr,
    });
    if (outcome._tag === "err") return err({ reason: "github_read" });
    return outcome.value.state === "merged"
      ? ok("merged")
      : err({ reason: "terminal" });
  }

  private async loadReview(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<
    Result<
      { readonly review: Review; readonly profile: WorkspaceProfileConfig },
      ReviewRefreshFailure
    >
  > {
    const [profile, review] = await Promise.all([
      this.dependencies.profiles.load(profileId),
      this.dependencies.reviews.load(profileId, reviewId),
    ]);
    if (profile._tag === "err" && profile.error.reason === "not_found")
      return err({ reason: "not_found" });
    if (review._tag === "err" && review.error.reason === "not_found")
      return err({ reason: "not_found" });
    if (profile._tag === "err" || review._tag === "err")
      return err({ reason: "storage" });
    return ok({ profile: profile.value, review: review.value });
  }

  private async serialized<T>(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    operation: () => Promise<Result<T, ReviewRefreshFailure>>,
  ): Promise<Result<T, ReviewRefreshFailure>> {
    return this.dependencies.operationCoordinator.withReviewLock(
      profileId,
      reviewId,
      operation,
    );
  }
}

function reviewRevisionOf(
  input: Pick<PullRequestSummary, "headSha" | "baseSha">,
): ReviewRevision | undefined {
  return input.baseSha === undefined
    ? undefined
    : { headSha: input.headSha, baseSha: input.baseSha };
}

/** The latest moment the represented snapshot content can vouch for, ignoring GitHub's lagging pullRequest.updatedAt. */
function latestRepresentedMoment(
  pullRequest: PullRequestSummary,
  comments: GitHubComments,
  publishedFeedback: GitHubPublishedFeedback | undefined,
): IsoTimestamp {
  let latest = Date.parse(pullRequest.updatedAt);
  for (const thread of comments.threads) {
    for (const comment of thread.comments)
      latest = Math.max(latest, Date.parse(comment.createdAt));
  }
  for (const review of publishedFeedback?.reviews ?? []) {
    latest = Math.max(latest, Date.parse(review.submittedAt));
  }
  for (const comment of publishedFeedback?.comments ?? []) {
    latest = Math.max(latest, Date.parse(comment.createdAt));
  }
  // A plain conversation comment appears nowhere else: `comments.threads` is
  // review threads only, so without this a refresh whose only new content is
  // an issue comment would vouch for an earlier moment than it holds.
  for (const comment of publishedFeedback?.issueComments ?? []) {
    latest = Math.max(latest, Date.parse(comment.createdAt));
  }
  // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601 instant.
  return new Date(latest).toISOString() as IsoTimestamp;
}

function ref(review: Review): PullRequestRef {
  return {
    host: review.identity.host,
    owner: review.identity.owner,
    repo: review.identity.repo,
    number: review.identity.prNumber,
  };
}

function mapPreparationFailure(
  tag: string,
  log?: Pick<AppLogService, "write">,
): Result<never, ReviewRefreshFailure> {
  const reason: ReviewRefreshFailure["reason"] =
    tag === "HeadChanged"
      ? "head_changed"
      : tag === "PullRequestStateChanged"
        ? "terminal"
        : tag === "ProfileNotFound"
          ? "not_found"
          : tag === "GitHubReadUnavailable"
            ? "github_read"
            : tag === "GitHubAuthenticationFailed"
              ? "github_auth"
              : "storage";
  // This is a default fallthrough: any preparation failure tag not named
  // above (currently ProfileUnavailable, SessionStorageUnavailable,
  // PreparationUnavailable, PreparationCleanupUnavailable) becomes "storage".
  // Logging the source tag before collapsing keeps that distinction visible.
  log?.write({
    process: "main",
    level: reason === "storage" ? "warn" : "debug",
    topic: "review-refresh",
    message: "preparation failure classified during refresh",
    meta: { tag, reason },
  });
  return err({ reason });
}
