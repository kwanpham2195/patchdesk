import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type {
  ReviewRemoteSnapshot,
  ReviewRemoteStore,
} from "../adapters/storage/review-remote-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  markReviewFresh,
  markReviewRevisionChanged,
  markReviewUnavailable,
  markReviewTerminal,
  moveReviewToSession,
  type ObservedRevisionIdentity,
  type RevisionUnavailableReason,
  type Review,
} from "../domain/review";
import type { PullRequestRef } from "../domain/pull-request";
import type {
  GitHubComments,
  GitHubMergeEvidence,
  GitHubPublishedFeedback,
  MergePolicySnapshot,
  PullRequestSummary,
} from "../domain/github-context";
import type {
  GitHubThreadId,
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";
import type { ReviewSessionPreparation } from "./review-session-preparation";
import type {
  ReviewWorkbenchProjection,
  WorkbenchProjectionFailure,
} from "./review-workbench-projection";
import type { PendingReviewService } from "./pending-review-service";
import type { PendingReviewState } from "../domain/pending-review";
import { hashSnapshot } from "../adapters/storage/review-remote-store";
import { GitHubRevisionIdentityReader } from "./github-revision-identity-reader";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

export type ReviewRefreshFailure = {
  readonly reason:
    | "invalid_input"
    | "not_found"
    | "github_read"
    | "storage"
    | "head_changed"
    | "terminal";
};

/**
 * Typed record of one GitHub write this app session made since the last
 * represented snapshot. Detection normalizes both sides of the fingerprint
 * with these entries so the app's own writes never read as remote updates,
 * while external activity in the same thread still does.
 */
export type RecentReviewWrite =
  | {
      readonly _tag: "Comment";
      readonly commentId: string;
      readonly reviewId?: string;
    }
  | {
      readonly _tag: "ThreadState";
      readonly threadId: GitHubThreadId;
      readonly state: "open" | "resolved";
    }
  | {
      readonly _tag: "PendingThread";
      readonly threadId: GitHubThreadId;
    }
  | {
      readonly _tag: "DirectSummaryReview";
      readonly reviewId: string;
    };

export type DetectionResult = {
  readonly updatesAvailable: boolean;
  readonly detectedAt: IsoTimestamp;
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
  readonly operationCoordinator: ReviewOperationCoordinator;
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

/** Separates cheap remote detection from the explicit, durable refresh command. */
export class ReviewRefreshService {

  constructor(private readonly dependencies: ReviewRefreshDependencies) {}

  async detect(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    /** Typed comment/thread-state writes this app session made; excluded from both sides of the fingerprint so own writes never read as remote updates. */
    readonly recentWrites?: ReadonlyArray<RecentReviewWrite>;
  }): Promise<Result<DetectionResult, ReviewRefreshFailure>> {
    return this.serialized<DetectionResult>(
      input.profileId,
      input.reviewId,
      async () => {
        const detectedAt = this.dependencies.now();
        const loaded = await this.loadReview(input.profileId, input.reviewId);
        if (loaded._tag === "err") return loaded;
        const { review, profile } = loaded.value;
        if (review.status._tag === "Terminal")
          return ok({ updatesAvailable: false, detectedAt });
        if (review.representedRemote === undefined)
          return ok({ updatesAvailable: false, detectedAt });
        const pr = ref(review);
        const representedHead = review.representedRemote.headSha;
        const current = await this.dependencies.github.getPullRequest({
          profile,
          pr,
        });
        if (current._tag === "err") return err({ reason: "github_read" });
        if (current.value.headSha !== representedHead) {
          return this.classifyChangedHead(
            input,
            review,
            profile,
            pr,
            detectedAt,
          );
        }
        const [checks, represented, comments, publishedFeedback, mergePolicy] =
          await Promise.all([
            this.dependencies.github.getPullRequestChecks({
              profile,
              pr,
              headSha: representedHead,
            }),
            this.dependencies.remote.load({
              profileId: input.profileId,
              reviewId: input.reviewId,
              snapshotHash: review.representedRemote.snapshotHash,
            }),
            this.dependencies.github.getPullRequestComments({ profile, pr }),
            this.dependencies.github.getPullRequestPublishedFeedback ===
            undefined
              ? Promise.resolve(ok(undefined))
              : this.dependencies.github.getPullRequestPublishedFeedback({
                  profile,
                  pr,
                }),
            this.dependencies.github.getMergePolicy({
              profile,
              pr,
              expectedHeadSha: representedHead,
            }),
          ]);
        if (
          checks._tag === "err" ||
          comments._tag === "err" ||
          publishedFeedback._tag === "err" ||
          mergePolicy._tag === "err"
        )
          return err({ reason: "github_read" });
        if (represented._tag === "err") return err({ reason: "storage" });
        const publishedFeedbackAvailable =
          represented.value.publishedFeedback !== undefined &&
          publishedFeedback.value !== undefined;
        const mergePolicyAvailable =
          represented.value.mergePolicy !== undefined &&
          mergePolicy.value !== undefined;
        const candidate: ReviewRemoteSnapshot = {
          schemaVersion: 1,
          pullRequest: current.value,
          comments: comments.value,
          commits: represented.value.commits,
          checks: checks.value,
          conversation: represented.value.conversation,
          ...(publishedFeedbackAvailable
            ? { publishedFeedback: publishedFeedback.value }
            : {}),
          ...(mergePolicyAvailable && mergePolicy.value !== undefined
            ? {
                mergePolicy: mergePolicy.value,
                mergeEvidence:
                  represented.value.mergeEvidence ??
                  toMergeEvidence(mergePolicy.value),
              }
            : {}),
        };
        const journal = input.recentWrites ?? [];
        const commentPair = withoutRecentWrites(
          candidate.comments,
          represented.value.comments,
          journal,
        );
        const candidateFeedback =
          publishedFeedbackAvailable && publishedFeedback.value !== undefined
            ? withoutJournaledFeedback(publishedFeedback.value, journal)
            : undefined;
        const representedFeedback =
          publishedFeedbackAvailable &&
          represented.value.publishedFeedback !== undefined
            ? withoutJournaledFeedback(
                represented.value.publishedFeedback,
                journal,
              )
            : undefined;
        // Optional readers are not evidence of a change when unavailable. Compare
        // only fields observed in this detection pass, while retaining the full
        // optional fields for explicit refresh.
        const metadataChanged =
          hashSnapshot(
            fingerprintForDetection(
              {
                ...candidate,
                comments: commentPair.candidate,
                ...(candidateFeedback === undefined
                  ? {}
                  : { publishedFeedback: candidateFeedback }),
              },
              {
                publishedFeedback: publishedFeedbackAvailable,
                mergePolicy: mergePolicyAvailable,
              },
            ),
          ) !==
          hashSnapshot(
            fingerprintForDetection(
              {
                ...represented.value,
                comments: commentPair.represented,
                ...(representedFeedback === undefined
                  ? {}
                  : { publishedFeedback: representedFeedback }),
              },
              {
                publishedFeedback: publishedFeedbackAvailable,
                mergePolicy: mergePolicyAvailable,
              },
            ),
          );
        if (!metadataChanged) {
          // Nothing in the snapshot content changed. GitHub's pullRequest.updatedAt
          // lags comment and review creation, so a stale represented marker or a
          // phantom detection flag must be healed instead of blocking GitHub writes.
          const latestMoment = latestRepresentedMoment(
            current.value,
            commentPair.candidate,
            candidateFeedback,
          );
          if (
            review.freshness._tag === "Fresh" &&
            latestMoment > review.representedRemote.pullRequestUpdatedAt
          ) {
            const healed = markReviewFresh(review, latestMoment, detectedAt);
            const saved = await this.dependencies.reviews.save(
              healed,
              review.updatedAt,
            );
            if (saved._tag === "err") return err({ reason: "storage" });
          }
          return ok({ updatesAvailable: false, detectedAt });
        }
        return this.markOrKeepUnavailable(input, review, detectedAt);
      },
    );
  }

  private async classifyChangedHead(
    input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
    review: Review,
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
    detectedAt: IsoTimestamp,
  ): Promise<Result<DetectionResult, ReviewRefreshFailure>> {
    const getPullRequestDiff = this.dependencies.github.getPullRequestDiff;
    if (getPullRequestDiff === undefined)
      return this.markOrKeepUnavailable(input, review, detectedAt);
    const session = await this.dependencies.sessions.load(
      input.profileId,
      review.currentSessionId,
    );
    if (session._tag === "err")
      return err({
        reason: session.error.reason === "not_found" ? "not_found" : "storage",
      });
    const comparison = await new GitHubRevisionIdentityReader({
      getPullRequest: this.dependencies.github.getPullRequest,
      getPullRequestDiff,
    }).read({ profile, pr, session: session.value });
    if (comparison._tag === "err") return err({ reason: "storage" });
    if (comparison.value._tag === "Changed") {
      return this.markOrKeepRevisionChanged(
        input,
        review,
        comparison.value.identity,
        detectedAt,
      );
    }
    if (comparison.value._tag === "Unavailable") {
      return this.markOrKeepUnavailable(
        input,
        review,
        detectedAt,
        comparison.value.reason,
      );
    }
    return this.markOrKeepUnavailable(input, review, detectedAt);
  }

  /** Persist a complete remote revision proof without adopting its session. */
  private async markOrKeepRevisionChanged(
    _input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
    review: Review,
    identity: ObservedRevisionIdentity,
    detectedAt: IsoTimestamp,
  ): Promise<Result<DetectionResult, ReviewRefreshFailure>> {
    if (
      review.freshness._tag === "RevisionChanged" &&
      review.freshness.identity.headSha === identity.headSha &&
      review.freshness.identity.baseSha === identity.baseSha &&
      review.freshness.identity.canonicalPatchHash ===
        identity.canonicalPatchHash
    )
      return ok({
        updatesAvailable: true,
        detectedAt: review.freshness.detectedAt,
      });
    const marked = markReviewRevisionChanged(
      review,
      { detectedAt, identity },
      detectedAt,
    );
    const saved = await this.dependencies.reviews.save(
      marked,
      review.updatedAt,
    );
    if (saved._tag === "err") return err({ reason: "storage" });
    return ok({ updatesAvailable: true, detectedAt });
  }

  /**
   * Until the observation service installs canonical identity proof, this
   * same-revision detector fails closed rather than treating a head-only result as
   * revision evidence. Its typed result preserves the refresh affordance.
   */
  private async markOrKeepUnavailable(
    _input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
    review: Review,
    detectedAt: IsoTimestamp,
    reason: RevisionUnavailableReason = "comparison_ambiguous",
  ): Promise<Result<DetectionResult, ReviewRefreshFailure>> {
    if (
      review.freshness._tag === "Unavailable" &&
      review.freshness.reason === reason
    ) {
      return ok({
        updatesAvailable: true,
        detectedAt: review.freshness.detectedAt,
      });
    }
    const marked = markReviewUnavailable(
      review,
      { detectedAt, reason },
      detectedAt,
    );
    const saved = await this.dependencies.reviews.save(
      marked,
      review.updatedAt,
    );
    if (saved._tag === "err") return err({ reason: "storage" });
    return ok({ updatesAvailable: true, detectedAt });
  }

  async refresh(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<unknown, ReviewRefreshFailure>> {
    return this.serialized<unknown>(
      input.profileId,
      input.reviewId,
      async () => {
        const loaded = await this.loadReview(input.profileId, input.reviewId);
        if (loaded._tag === "err") return loaded;
        const { review, profile } = loaded.value;
        if (review.status._tag === "Terminal")
          return err({ reason: "terminal" });
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
        if (verified.value.headSha !== current.value.headSha)
          return err({ reason: "head_changed" });
        const candidate: ReviewRemoteSnapshot = {
          schemaVersion: 1,
          pullRequest: current.value,
          comments: comments.value,
          commits: commits.value,
          checks: checks.value,
          conversation: conversation.value,
          ...(publishedFeedback.value === undefined
            ? {}
            : { publishedFeedback: publishedFeedback.value }),
          mergePolicy: mergePolicy.value,
          mergeEvidence: toMergeEvidence(
            mergePolicy.value,
            policyEvidence._tag === "ok" ? policyEvidence.value : undefined,
          ),
        };
        const savedCandidate = await this.dependencies.remote.saveCandidate({
          profileId: input.profileId,
          reviewId: input.reviewId,
          snapshot: candidate,
        });
        if (savedCandidate._tag === "err") return err({ reason: "storage" });
        let sessionId = review.currentSessionId;
        if (current.value.headSha !== review.currentHeadSha) {
          const prepared = await this.dependencies.preparation.prepare({
            profileId: input.profileId,
            pullRequest,
          });
          if (prepared._tag === "err")
            return mapPreparationFailure(prepared.error._tag);
          if (prepared.value.session.key.headSha !== current.value.headSha)
            return err({ reason: "head_changed" });
          const persisted = await this.dependencies.sessions.save(
            prepared.value.session,
          );
          if (persisted._tag === "err") return err({ reason: "storage" });
          sessionId = prepared.value.session.id;
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
        const terminalState = !current.value.isOpen
          ? await this.authoritativeTerminalState(profile, pullRequest)
          : undefined;
        if (terminalState?._tag === "err")
          return err({ reason: "github_read" });
        const authoritative =
          terminalState?.value === undefined
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
        if (this.dependencies.project === undefined)
          return ok({ review: authoritative, sessionId, snapshot: candidate });
        // Explicit refresh reconciles the viewer's pending review; a failed read
        // is unavailable in the projection, never a claim that none exists.
        const reconciled =
          await this.dependencies.pendingReview.reconcileWithinReviewLock({
            profileId: input.profileId,
            reviewId: input.reviewId,
          });
        const pendingReview = {
          state:
            reconciled._tag === "ok"
              ? reconciled.value.state
              : (currentSession.value.pendingReview ??
                ({ _tag: "None" } as PendingReviewState)),
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
      },
    );
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

function fingerprintForDetection(
  snapshot: ReviewRemoteSnapshot,
  available: {
    readonly publishedFeedback: boolean;
    readonly mergePolicy: boolean;
  },
): ReviewRemoteSnapshot {
  return {
    schemaVersion: 1,
    // GitHub's pullRequest.updatedAt lags comment and review creation, so it
    // is normalized to a sentinel before hashing. Including it verbatim would
    // make detection flag a phantom update and block GitHub writes.
    pullRequest: omitVolatilePullRequestState(snapshot.pullRequest),
    comments: withoutViewerMetadata(snapshot.comments),
    conversation: snapshot.conversation,
    commits: snapshot.commits,
    checks: snapshot.checks,
    ...(available.publishedFeedback && snapshot.publishedFeedback !== undefined
      ? {
          publishedFeedback: withoutFeedbackPermissions(
            snapshot.publishedFeedback,
          ),
        }
      : {}),
    ...(available.mergePolicy && snapshot.mergePolicy !== undefined
      ? {
          mergePolicy: fingerprintMergePolicy(snapshot.mergePolicy),
          mergeEvidence: fingerprintMergeEvidence(snapshot),
        }
      : {}),
  };
}

function fingerprintMergePolicy(
  policy: MergePolicySnapshot,
): MergePolicySnapshot {
  // The policy query is permission-limited in some profiles and returns its
  // check list in a different order than the checks query. Detection hashes
  // the stable semantic state only, never the completeness markers.
  const checks = [...policy.checks.checks]
    .map(({ name, required, status, conclusion }) => ({
      name,
      required,
      status,
      ...(conclusion === undefined ? {} : { conclusion }),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    pr: policy.pr,
    headSha: policy.headSha,
    isOpen: policy.isOpen,
    isDraft: policy.isDraft,
    mergeability: policy.mergeability,
    ...(policy.mergeStateStatus === undefined
      ? {}
      : { mergeStateStatus: policy.mergeStateStatus }),
    reviewDecision: policy.reviewDecision,
    checks: { overall: policy.checks.overall, checks },
    complete: true,
  };
}

function fingerprintMergeEvidence(
  snapshot: ReviewRemoteSnapshot,
): GitHubMergeEvidence {
  // Detection never fetches optional policy evidence; the represented
  // snapshot's policy field must not make the fingerprints diverge.
  const evidence =
    snapshot.mergeEvidence ??
    toMergeEvidence(snapshot.mergePolicy as MergePolicySnapshot);
  return {
    mergeable: evidence.mergeable,
    mergeStateStatus: evidence.mergeStateStatus,
    reviewDecision: evidence.reviewDecision,
  };
}

function withoutViewerMetadata(comments: GitHubComments): GitHubComments {
  // viewerDidAuthor is viewer-relative and GitHub can return it late for
  // freshly created comments; it must not read as a remote content change.
  return {
    ...comments,
    threads: comments.threads.map((thread) => ({
      ...thread,
      comments: thread.comments.map(
        ({ viewerDidAuthor: _viewerDidAuthor, ...comment }) => {
          void _viewerDidAuthor;
          return comment;
        },
      ),
    })),
  };
}

function withoutRecentWrites(
  candidate: GitHubComments,
  represented: GitHubComments,
  journal: ReadonlyArray<RecentReviewWrite>,
): {
  readonly candidate: GitHubComments;
  readonly represented: GitHubComments;
} {
  // Comments and threads written by this app session are not yet part of the
  // represented snapshot; exclude them symmetrically so they never read as a
  // remote update, while genuine external changes still are detected.
  if (journal.length === 0) return { candidate, represented };
  const commentIds = new Set<string>();
  const latestThreadStateById = new Map<GitHubThreadId, "open" | "resolved">();
  const pendingThreadIds = new Set<GitHubThreadId>();
  for (const entry of journal) {
    if (entry._tag === "Comment") {
      commentIds.add(entry.commentId);
    } else if (entry._tag === "ThreadState") {
      latestThreadStateById.set(entry.threadId, entry.state);
    } else if (entry._tag === "PendingThread") {
      pendingThreadIds.add(entry.threadId);
    }
  }
  const withoutComments = (comments: GitHubComments): GitHubComments => ({
    ...comments,
    // Remove only the journaled comment; a thread survives while any other
    // (external) comment remains in it, so an external reply in a thread this
    // session touched is still a fingerprint difference.
    threads: comments.threads
      .map((thread) => ({
        ...thread,
        comments: thread.comments.filter(
          (comment) => !commentIds.has(comment.id),
        ),
      }))
      .filter((thread) => thread.comments.length > 0),
  });
  // A pending-review thread this session created (Start/AddThread) appears only
  // in the candidate snapshot; one this session discarded appears only in the
  // represented snapshot. Removing the exact journaled thread from BOTH sides
  // is symmetric, so neither the app-owned addition nor the removal reads as a
  // remote update, while any unrelated thread change still differs.
  const withoutOwnPendingThreads = (
    comments: GitHubComments,
  ): GitHubComments => ({
    ...comments,
    threads: comments.threads.filter(
      (thread) => !pendingThreadIds.has(thread.id),
    ),
  });
  const representedWithoutOwnComments = withoutComments(represented);
  const representedWithoutOwn = withoutOwnPendingThreads(
    representedWithoutOwnComments,
  );
  return {
    candidate: withoutOwnPendingThreads(withoutComments(candidate)),
    // Thread-state normalization is intentionally asymmetric: the successful
    // local change must not read as an update, so the represented side is
    // forced to the requested state, while the candidate side keeps whatever
    // GitHub reports. A later external state change therefore differs and
    // blocks writes; a false stale signal during GitHub propagation is
    // deliberately preferred over a false fresh signal.
    represented: {
      ...representedWithoutOwn,
      threads: representedWithoutOwn.threads.map((thread) => {
        const forced = latestThreadStateById.get(thread.id);
        return forced === undefined ? thread : { ...thread, state: forced };
      }),
    },
  };
}

function withoutJournaledFeedback(
  feedback: GitHubPublishedFeedback,
  journal: ReadonlyArray<RecentReviewWrite>,
): GitHubPublishedFeedback {
  // A comment create also submits its own COMMENTED review; exclude both the
  // review and the comment from detection until a refresh re-baselines.
  if (journal.length === 0) return feedback;
  const commentIds = new Set<string>();
  const reviewIds = new Set<string>();
  for (const entry of journal) {
    if (entry._tag === "DirectSummaryReview") {
      reviewIds.add(entry.reviewId);
      continue;
    }
    if (entry._tag !== "Comment") continue;
    commentIds.add(entry.commentId);
    if (entry.reviewId !== undefined) reviewIds.add(entry.reviewId);
  }
  return {
    ...feedback,
    reviews: feedback.reviews.filter(
      (review) =>
        !reviewIds.has(review.id) &&
        !reviewIds.has(review.nodeId ?? "") &&
        !commentIds.has(review.nodeId ?? ""),
    ),
    comments: feedback.comments.filter(
      (comment) =>
        !commentIds.has(comment.id) &&
        !commentIds.has(comment.nodeId ?? "") &&
        !reviewIds.has(comment.id),
    ),
  };
}

function withoutFeedbackPermissions(
  feedback: GitHubPublishedFeedback,
): GitHubPublishedFeedback {
  // viewerDidAuthor is viewer-relative gating metadata derived from the same
  // review event; only the event content is remote state.
  return {
    ...feedback,
    comments: feedback.comments.map(
      ({ viewerDidAuthor: _viewerDidAuthor, ...comment }) => {
        void _viewerDidAuthor;
        return comment;
      },
    ),
  };
}

function omitVolatilePullRequestState(
  pullRequest: PullRequestSummary,
): PullRequestSummary {
  // Detection must hash content, not volatile metadata: GitHub's updatedAt
  // lags comment and review creation, so a fixed sentinel keeps both sides
  // comparable regardless of propagation delay.
  return {
    ...pullRequest,
    updatedAt: "1970-01-01T00:00:00.000Z" as IsoTimestamp,
  };
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
  return new Date(latest).toISOString() as IsoTimestamp;
}

function toMergeEvidence(
  policy: NonNullable<ReviewRemoteSnapshot["mergePolicy"]>,
  policyEvidence?: NonNullable<ReviewRemoteSnapshot["mergeEvidence"]>["policy"],
): NonNullable<ReviewRemoteSnapshot["mergeEvidence"]> {
  return {
    mergeable: policy.mergeability,
    mergeStateStatus: policy.mergeStateStatus ?? "unavailable",
    reviewDecision: policy.reviewDecision,
    ...(policyEvidence === undefined ? {} : { policy: policyEvidence }),
  };
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
): Result<never, ReviewRefreshFailure> {
  return err({
    reason:
      tag === "HeadChanged"
        ? "head_changed"
        : tag === "ProfileNotFound"
          ? "not_found"
          : tag === "GitHubReadUnavailable"
            ? "github_read"
            : "storage",
  });
}
