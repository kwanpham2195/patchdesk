import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewRemoteSnapshot, ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { markDetectedUpdate, markReviewTerminal, moveReviewToSession, type Review } from "../domain/review";
import type { PullRequestRef } from "../domain/pull-request";
import type { IsoTimestamp, ReviewId, ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";
import type { ReviewSessionPreparation } from "./review-session-preparation";
import type { ReviewWorkbenchProjection, WorkbenchProjectionFailure } from "./review-workbench-projection";
import { hashSnapshot } from "../adapters/storage/review-remote-store";

export type ReviewRefreshFailure = {
  readonly reason: "invalid_input" | "not_found" | "github_read" | "storage" | "head_changed" | "terminal";
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
  readonly github: Pick<GitHubReader, "getPullRequest" | "getPullRequestComments" | "getPullRequestCommits" | "getPullRequestChecks" | "getMergePolicy"> & Partial<Pick<GitHubReader, "getMergeOutcome">>;
  readonly preparation: Pick<ReviewSessionPreparation, "prepare">;
  readonly now: () => IsoTimestamp;
  readonly project?: (input: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
    readonly snapshot: ReviewRemoteSnapshot;
    readonly refreshedAt: IsoTimestamp;
  }) => Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>>;
};

/** Separates cheap remote detection from the explicit, durable refresh command. */
export class ReviewRefreshService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: ReviewRefreshDependencies) {}

  async detect(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<DetectionResult, ReviewRefreshFailure>> {
    return this.serialized<DetectionResult>(input.profileId, input.reviewId, async () => {
      const detectedAt = this.dependencies.now();
      const loaded = await this.loadReview(input.profileId, input.reviewId);
      if (loaded._tag === "err") return loaded;
      const { review, profile } = loaded.value;
      if (review.status._tag === "Terminal") return ok({ updatesAvailable: false, detectedAt });
      if (review.representedRemote === undefined) return ok({ updatesAvailable: false, detectedAt });
      const pr = ref(review);
      // A new head is sufficient evidence of an update. Do not let an old-head
      // checks outage hide it from the caller.
      const current = await this.dependencies.github.getPullRequest({ profile, pr });
      if (current._tag === "err") return err({ reason: "github_read" });
      const representedHead = review.representedRemote.headSha;
      const reason = current.value.headSha !== representedHead
        ? "head" as const
        : current.value.updatedAt > review.representedRemote.pullRequestUpdatedAt
          ? "pull_request" as const
          : undefined;
      if (reason !== undefined) {
        const marked = markDetectedUpdate(review, { detectedAt, reason }, detectedAt);
        const saved = await this.dependencies.reviews.save(marked, review.updatedAt);
        return saved._tag === "err" ? err({ reason: "storage" }) : ok({ updatesAvailable: true, detectedAt });
      }
      const [checks, represented] = await Promise.all([
        this.dependencies.github.getPullRequestChecks({ profile, pr, headSha: representedHead }),
        this.dependencies.remote.load({ profileId: input.profileId, reviewId: input.reviewId, snapshotHash: review.representedRemote.snapshotHash }),
      ]);
      if (checks._tag === "err") return err({ reason: "github_read" });
      if (represented._tag === "err") return err({ reason: "storage" });
      const checksChanged = hashSnapshot({ schemaVersion: 1, pullRequest: represented.value.pullRequest, comments: represented.value.comments, commits: represented.value.commits, checks: checks.value, ...(represented.value.mergePolicy === undefined ? {} : { mergePolicy: represented.value.mergePolicy }) }) !== review.representedRemote.snapshotHash;
      if (!checksChanged) return ok({ updatesAvailable: false, detectedAt });
      const marked = markDetectedUpdate(review, { detectedAt, reason: "checks" }, detectedAt);
      const saved = await this.dependencies.reviews.save(marked, review.updatedAt);
      return saved._tag === "err" ? err({ reason: "storage" }) : ok({ updatesAvailable: true, detectedAt });
    });
  }

  async refresh(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<unknown, ReviewRefreshFailure>> {
    return this.serialized<unknown>(input.profileId, input.reviewId, async () => {
      const loaded = await this.loadReview(input.profileId, input.reviewId);
      if (loaded._tag === "err") return loaded;
      const { review, profile } = loaded.value;
      if (review.status._tag === "Terminal") return err({ reason: "terminal" });
      const currentSession = await this.dependencies.sessions.load(input.profileId, review.currentSessionId);
      if (currentSession._tag === "err") {
        return currentSession.error.reason === "not_found"
          ? err({ reason: "not_found" })
          : err({ reason: "storage" });
      }
      if (currentSession.value.id !== review.currentSessionId) return err({ reason: "storage" });
      if (currentSession.value.key.profileId !== review.identity.profileId || currentSession.value.key.host !== review.identity.host || currentSession.value.key.owner !== review.identity.owner || currentSession.value.key.repo !== review.identity.repo || currentSession.value.key.prNumber !== review.identity.prNumber) {
        return err({ reason: "storage" });
      }
      if (currentSession.value.key.headSha !== review.currentHeadSha) return err({ reason: "head_changed" });
      const pullRequest = ref(review);
      const current = await this.dependencies.github.getPullRequest({ profile, pr: pullRequest });
      if (current._tag === "err") return err({ reason: "github_read" });
      const [comments, commits, checks, mergePolicy] = await Promise.all([
        this.dependencies.github.getPullRequestComments({ profile, pr: pullRequest }),
        this.dependencies.github.getPullRequestCommits({ profile, pr: pullRequest }),
        this.dependencies.github.getPullRequestChecks({ profile, pr: pullRequest, headSha: current.value.headSha }),
        this.dependencies.github.getMergePolicy({ profile, pr: pullRequest, expectedHeadSha: current.value.headSha }),
      ]);
      if (comments._tag === "err" || commits._tag === "err" || checks._tag === "err" || mergePolicy._tag === "err") return err({ reason: "github_read" });
      const verified = await this.dependencies.github.getPullRequest({ profile, pr: pullRequest });
      if (verified._tag === "err") return err({ reason: "github_read" });
      if (verified.value.headSha !== current.value.headSha) return err({ reason: "head_changed" });
      const candidate: ReviewRemoteSnapshot = { schemaVersion: 1, pullRequest: current.value, comments: comments.value, commits: commits.value, checks: checks.value, mergePolicy: mergePolicy.value };
      const savedCandidate = await this.dependencies.remote.saveCandidate({ profileId: input.profileId, reviewId: input.reviewId, snapshot: candidate });
      if (savedCandidate._tag === "err") return err({ reason: "storage" });
      let sessionId = review.currentSessionId;
      if (current.value.headSha !== review.currentHeadSha) {
        const prepared = await this.dependencies.preparation.prepare({
          profileId: input.profileId,
          pullRequest,
          mode: { kind: "full" },
          previousSessionId: review.currentSessionId,
        });
        if (prepared._tag === "err") return mapPreparationFailure(prepared.error._tag);
        if (prepared.value.session.key.headSha !== current.value.headSha) return err({ reason: "head_changed" });
        const persisted = await this.dependencies.sessions.save(prepared.value.session);
        if (persisted._tag === "err") return err({ reason: "storage" });
        sessionId = prepared.value.session.id;
      }
      const representedRemote = { headSha: current.value.headSha, pullRequestUpdatedAt: current.value.updatedAt, snapshotHash: savedCandidate.value.snapshotHash, refreshedAt: this.dependencies.now() };
      const advanced = moveReviewToSession(review, { sessionId, headSha: current.value.headSha, representedRemote, updatedAt: representedRemote.refreshedAt });
      if (advanced._tag === "err") return err({ reason: "terminal" });
      const terminalState = !current.value.isOpen
        ? await this.authoritativeTerminalState(profile, pullRequest)
        : undefined;
      if (terminalState?._tag === "err") return err({ reason: "github_read" });
      const authoritative = terminalState?.value === undefined
        ? advanced.value
        : markReviewTerminal(advanced.value, terminalState.value, representedRemote.refreshedAt);
      const savedReview = await this.dependencies.reviews.save(authoritative, review.updatedAt);
      if (savedReview._tag === "err") return err({ reason: "storage" });
      if (this.dependencies.project === undefined) return ok({ review: authoritative, sessionId, snapshot: candidate });
      const projected = await this.dependencies.project({
        profileId: input.profileId,
        sessionId,
        snapshot: candidate,
        refreshedAt: representedRemote.refreshedAt,
      });
      return projected._tag === "ok"
        ? projected
        : err({ reason: "storage" });
    });
  }

  private async authoritativeTerminalState(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<Result<"merged" | "closed" | undefined, ReviewRefreshFailure> | undefined> {
    if (this.dependencies.github.getMergeOutcome === undefined) return ok("closed");
    const outcome = await this.dependencies.github.getMergeOutcome({ profile, pr });
    if (outcome._tag === "err") return err({ reason: "github_read" });
    if (outcome.value.state === "merged") return ok("merged");
    if (outcome.value.state === "closed_unmerged") return ok("closed");
    return ok(undefined);
  }

  private async loadReview(profileId: WorkspaceProfileId, reviewId: ReviewId): Promise<Result<{ readonly review: Review; readonly profile: WorkspaceProfileConfig }, ReviewRefreshFailure>> {
    const [profile, review] = await Promise.all([this.dependencies.profiles.load(profileId), this.dependencies.reviews.load(profileId, reviewId)]);
    if (profile._tag === "err" && profile.error.reason === "not_found") return err({ reason: "not_found" });
    if (review._tag === "err" && review.error.reason === "not_found") return err({ reason: "not_found" });
    if (profile._tag === "err" || review._tag === "err") return err({ reason: "storage" });
    return ok({ profile: profile.value, review: review.value });
  }

  private async serialized<T>(profileId: WorkspaceProfileId, reviewId: ReviewId, operation: () => Promise<Result<T, ReviewRefreshFailure>>): Promise<Result<T, ReviewRefreshFailure>> {
    const key = `${profileId}:${reviewId}`;
    const predecessor = this.locks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    if (predecessor !== undefined) await predecessor;
    try { return await operation(); } finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }
}

function ref(review: Review): PullRequestRef {
  return { host: review.identity.host, owner: review.identity.owner, repo: review.identity.repo, number: review.identity.prNumber };
}

function mapPreparationFailure(tag: string): Result<never, ReviewRefreshFailure> {
  return err({ reason: tag === "HeadChanged" ? "head_changed" : tag === "ProfileNotFound" || tag === "IncrementalBaseNotFound" ? "not_found" : tag === "GitHubReadUnavailable" ? "github_read" : "storage" });
}
