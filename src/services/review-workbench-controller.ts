import type { Review } from "../domain/review";
import type { ReviewId, WorkspaceProfileId } from "../domain/ids";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseReviewId,
  createReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../domain/ids";
import { createReview } from "../domain/review";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import type { ReviewRefreshService } from "./review-refresh-service";
import type { ReviewCommitService } from "./review-commit-service";
import { err, ok, type Result } from "../domain/result";
import type { PrepareReviewSessionFailure, ReviewOpenMode, ReviewSessionPreparation } from "./review-session-preparation";
import type {
  ReviewWorkbenchProjection,
  ReviewWorkbenchProjectionService,
  WorkbenchProjectionFailure,
} from "./review-workbench-projection";
import { readObjectField } from "./read-object-field";

export type ReviewWorkbenchFailure = { readonly reason: "invalid_input" | "not_found" | "github_read" | "head_changed" | "storage" | "terminal" | "revision_conflict" | "not_fresh" };
export type { ReviewWorkbenchProjection };

/**
 * Temporary local-API application facade. It retains the current unknown-input
 * parser and maps precise preparation/projection failures onto the existing
 * route vocabulary. Opening a new Review performs its one initial GitHub
 * snapshot fetch; later remote changes still require explicit refresh.
 */
export class ReviewWorkbenchController {
  private readonly openLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly preparation: ReviewSessionPreparation,
    private readonly projection: ReviewWorkbenchProjectionService,
    private readonly lifecycle?: {
      readonly reviews: Pick<ReviewStore, "load" | "save">;
      readonly remote: Pick<ReviewRemoteStore, "load">;
      readonly refresh: ReviewRefreshService;
      readonly commits?: ReviewCommitService;
      readonly migration?: { migrateProfile(profileId: WorkspaceProfileId): Promise<Result<unknown, unknown>> };
    },
  ) {}

  async open(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const identityFields = {
      profileId: parseWorkspaceProfileId(readObjectField(input, "profileId")),
      host: parseGitHubHost(readObjectField(input, "host")),
      owner: parseGitHubOwner(readObjectField(input, "owner")),
      repo: parseGitHubRepoName(readObjectField(input, "repo")),
      number: parsePullRequestNumber(readObjectField(input, "number")),
    };
    if (identityFields.profileId._tag === "err" || identityFields.host._tag === "err" || identityFields.owner._tag === "err" || identityFields.repo._tag === "err" || identityFields.number._tag === "err") return err({ reason: "invalid_input" });
    const profileId = identityFields.profileId.value;
    const reviewId = createReviewId({ profileId, host: identityFields.host.value, owner: identityFields.owner.value, repo: identityFields.repo.value, prNumber: identityFields.number.value });
    return this.serializedOpen(profileId, reviewId, async () => {
      const migrated = await this.migrate(profileId);
      if (migrated._tag === "err") return err({ reason: "storage" });
      return this.openUnlocked(input);
    });
  }

  private async openUnlocked(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const host = parseGitHubHost(readObjectField(input, "host"));
    const owner = parseGitHubOwner(readObjectField(input, "owner"));
    const repo = parseGitHubRepoName(readObjectField(input, "repo"));
    const number = parsePullRequestNumber(readObjectField(input, "number"));
    if (profileId._tag === "err" || host._tag === "err" || owner._tag === "err" || repo._tag === "err" || number._tag === "err") return err({ reason: "invalid_input" });
    const requestedMode = readObjectField(input, "mode");
    if (requestedMode !== undefined && requestedMode !== "full" && requestedMode !== "incremental") return err({ reason: "invalid_input" });
    let mode: ReviewOpenMode = { kind: "full" };
    if (requestedMode === "incremental") {
      const baseSessionId = parseReviewSessionId(readObjectField(input, "baseSessionId"));
      if (baseSessionId._tag === "err") return err({ reason: "invalid_input" });
      mode = { kind: "incremental", baseSessionId: baseSessionId.value };
    }
    const previousSessionRaw = readObjectField(input, "previousSessionId");
    const parsedPreviousSessionId = previousSessionRaw === undefined
      ? undefined
      : parseReviewSessionId(previousSessionRaw);
    if (parsedPreviousSessionId?._tag === "err") return err({ reason: "invalid_input" });
    const previousSessionId = parsedPreviousSessionId?._tag === "ok"
      ? parsedPreviousSessionId.value
      : mode.kind === "incremental" ? mode.baseSessionId : undefined;
    const identity = { profileId: profileId.value, host: host.value, owner: owner.value, repo: repo.value, prNumber: number.value };
    const reviewId = createReviewId(identity);
    const existing = this.lifecycle === undefined
      ? undefined
      : await this.lifecycle.reviews.load(profileId.value, reviewId);
    if (existing?._tag === "err" && existing.error.reason !== "not_found") return err({ reason: "storage" });
    if (existing?._tag === "ok") {
      if (existing.value.representedRemote === undefined) {
        const initialized = await this.initializeSnapshot(profileId.value, reviewId);
        return initialized._tag === "err" ? initialized : this.projectStable(initialized.value);
      }
      const stable = await this.projectStable(existing.value);
      if (stable._tag === "ok" || stable.error.reason !== "not_found") return stable;

      // Session artifacts are disposable local cache. If cleanup or a previous
      // interrupted run removed them, rebuild the current PR instead of leaving
      // its durable Review record impossible to open.
      const repaired = await this.preparation.prepare({
        profileId: profileId.value,
        pullRequest: { host: host.value, owner: owner.value, repo: repo.value, number: number.value },
        mode: { kind: "full" },
      });
      if (repaired._tag === "err") return err(mapPreparationFailure(repaired.error));
      const saved = await this.lifecycle?.reviews.save({
        ...existing.value,
        currentSessionId: repaired.value.session.id,
        currentHeadSha: repaired.value.session.key.headSha,
        representedRemote: undefined,
        detectedUpdate: undefined,
        updatedAt: repaired.value.session.createdAt,
      }, existing.value.updatedAt);
      if (saved?._tag === "err") return err({ reason: "storage" });
      const initialized = await this.initializeSnapshot(profileId.value, reviewId);
      return initialized._tag === "err" ? initialized : this.projectStable(initialized.value);
    }
    const prepared = await this.preparation.prepare({
      profileId: profileId.value,
      pullRequest: { host: host.value, owner: owner.value, repo: repo.value, number: number.value },
      mode,
      ...(previousSessionId === undefined ? {} : { previousSessionId }),
    });
    if (prepared._tag === "err") return err(mapPreparationFailure(prepared.error));
    // The lifecycle facade is optional for the legacy/session-only route. Keep
    // its original first-open behavior: prepare, then project the session
    // directly instead of trying to initialize a durable Review snapshot.
    if (this.lifecycle === undefined) {
      const projected = await this.projection.load({ profileId: profileId.value, sessionId: prepared.value.session.id });
      return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
    }
    const created = createReview({ identity, currentSessionId: prepared.value.session.id, headSha: prepared.value.session.key.headSha, createdAt: prepared.value.session.createdAt });
    const saved = await this.lifecycle.reviews.save(created);
    if (saved._tag === "err") return err({ reason: "storage" });
    const initialized = await this.initializeSnapshot(profileId.value, reviewId);
    return initialized._tag === "err" ? initialized : this.projectStable(initialized.value);
  }

  private async initializeSnapshot(profileId: WorkspaceProfileId, reviewId: ReviewId): Promise<Result<Review, ReviewWorkbenchFailure>> {
    const initialRefresh = await this.lifecycle?.refresh.refresh?.({ profileId, reviewId });
    if (initialRefresh?._tag === "err") return err({ reason: initialRefresh.error.reason });
    const refreshedReview = await this.lifecycle?.reviews.load(profileId, reviewId);
    if (refreshedReview?._tag === "err") return err({ reason: refreshedReview.error.reason === "not_found" ? "not_found" : "storage" });
    if (refreshedReview?._tag === "ok") return ok(refreshedReview.value);
    return err({ reason: "storage" });
  }

  private async projectStable(review: Review): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    if (this.lifecycle === undefined || review.representedRemote === undefined) {
      const projected = await this.projection.loadLocal({ profileId: review.identity.profileId, sessionId: review.currentSessionId });
      return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
    }
    if (review.representedRemote.headSha !== review.currentHeadSha) {
      const projected = await this.projection.loadLocal({ profileId: review.identity.profileId, sessionId: review.currentSessionId });
      return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
    }
    const snapshot = await this.lifecycle.remote.load({ profileId: review.identity.profileId, reviewId: review.id, snapshotHash: review.representedRemote.snapshotHash });
    if (snapshot._tag === "err") return err({ reason: "storage" });
    const projected = await this.projection.loadRepresented({ profileId: review.identity.profileId, sessionId: review.currentSessionId, snapshot: snapshot.value, refreshedAt: review.representedRemote.refreshedAt, updatesAvailable: review.detectedUpdate !== undefined });
    return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
  }

  async load(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    if (profileId._tag === "err") return err({ reason: "invalid_input" });
    const migrated = await this.migrate(profileId.value);
    if (migrated._tag === "err") return err({ reason: "storage" });
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    if (this.lifecycle !== undefined && reviewId._tag === "err" && sessionId._tag === "err") return err({ reason: "invalid_input" });
    if (reviewId._tag === "ok" && this.lifecycle !== undefined) {
      const review = await this.lifecycle.reviews.load(profileId.value, reviewId.value);
      if (review._tag === "err") return err({ reason: review.error.reason === "not_found" ? "not_found" : "storage" });
      if (review.value.representedRemote === undefined || review.value.representedRemote.headSha !== review.value.currentHeadSha) {
        const projected = await this.projection.loadLocal({ profileId: profileId.value, sessionId: review.value.currentSessionId });
        return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
      }
      const snapshot = await this.lifecycle.remote.load({
        profileId: profileId.value,
        reviewId: reviewId.value,
        snapshotHash: review.value.representedRemote.snapshotHash,
      });
      if (snapshot._tag === "err") return err({ reason: "storage" });
      const projected = await this.projection.loadRepresented({
        profileId: profileId.value,
        sessionId: review.value.currentSessionId,
        snapshot: snapshot.value,
        refreshedAt: review.value.representedRemote.refreshedAt,
        updatesAvailable: review.value.detectedUpdate !== undefined,
      });
      return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
    }
    if (sessionId._tag === "err") return err({ reason: "invalid_input" });
    const projected = await this.projection.load({ profileId: profileId.value, sessionId: sessionId.value });
    return projected._tag === "err" ? err(mapProjectionFailure(projected.error)) : projected;
  }

  private async migrate(profileId: WorkspaceProfileId): Promise<Result<unknown, unknown>> {
    return this.lifecycle?.migration === undefined ? { _tag: "ok", value: undefined } : this.lifecycle.migration.migrateProfile(profileId);
  }

  async commitDiff(input: unknown): Promise<Result<unknown, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    const commitSha = parseGitSha(readObjectField(input, "commitSha"));
    if (profileId._tag === "err" || reviewId._tag === "err" || commitSha._tag === "err" || this.lifecycle?.commits === undefined) return err({ reason: "invalid_input" });
    const result = await this.lifecycle.commits.diff({ profileId: profileId.value, reviewId: reviewId.value, commitSha: commitSha.value });
    return result._tag === "err" ? err({ reason: result.error.reason === "not_found" ? "not_found" : result.error.reason === "stale_head" || result.error.reason === "foreign_commit" ? "head_changed" : "storage" }) : result;
  }

  async detectUpdates(input: unknown): Promise<Result<unknown, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err" || this.lifecycle === undefined) return err({ reason: "invalid_input" });
    const detected = await this.lifecycle.refresh.detect({ profileId: profileId.value, reviewId: reviewId.value });
    return detected._tag === "err" ? err({ reason: detected.error.reason }) : detected;
  }

  async refresh(input: unknown): Promise<Result<unknown, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    if (profileId._tag === "ok" && reviewId._tag === "ok" && this.lifecycle !== undefined) {
      const refreshed = await this.lifecycle.refresh.refresh({ profileId: profileId.value, reviewId: reviewId.value });
      return refreshed._tag === "err" ? err({ reason: refreshed.error.reason }) : refreshed;
    }
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    if (profileId._tag === "err" || sessionId._tag === "err") return err({ reason: "invalid_input" });
    const refreshed = await this.projection.refreshRemote({ profileId: profileId.value, sessionId: sessionId.value });
    return refreshed._tag === "err" ? err(mapProjectionFailure(refreshed.error)) : refreshed;
  }

  private async serializedOpen<T>(profileId: WorkspaceProfileId, reviewId: ReviewId, operation: () => Promise<Result<T, ReviewWorkbenchFailure>>): Promise<Result<T, ReviewWorkbenchFailure>> {
    const key = `${profileId}:${reviewId}`;
    const predecessor = this.openLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.openLocks.set(key, current);
    if (predecessor !== undefined) await predecessor;
    try { return await operation(); } finally { release(); if (this.openLocks.get(key) === current) this.openLocks.delete(key); }
  }
}

function mapPreparationFailure(failure: PrepareReviewSessionFailure): ReviewWorkbenchFailure {
  switch (failure._tag) {
    case "ProfileNotFound":
    case "IncrementalBaseNotFound":
      return { reason: "not_found" };
    case "InvalidIncrementalBase":
      return { reason: "invalid_input" };
    case "GitHubReadUnavailable":
      return { reason: "github_read" };
    case "HeadChanged":
      return { reason: "head_changed" };
    case "ProfileUnavailable":
    case "SessionStorageUnavailable":
    case "PreparationUnavailable":
    case "PreparationCleanupUnavailable":
      return { reason: "storage" };
  }
}

function mapProjectionFailure(failure: WorkbenchProjectionFailure): ReviewWorkbenchFailure {
  switch (failure._tag) {
    case "ProfileNotFound":
    case "SessionNotFound":
      return { reason: "not_found" };
    case "SessionStorageUnavailable":
      return { reason: "storage" };
  }
}
