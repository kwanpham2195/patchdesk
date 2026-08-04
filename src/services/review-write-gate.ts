import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewRemoteSnapshot, ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { Review } from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ContentHash, IsoTimestamp, ReviewId, ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { contentHash } from "./review-artifact-hash";

export type ReviewWriteGateFailure = {
  readonly reason: "not_found" | "storage" | "stale" | "terminal" | "not_fresh";
};

export type FreshReview = {
  readonly profile: WorkspaceProfileConfig;
  readonly review: Review;
  readonly session: ReviewSession;
  readonly snapshot: ReviewRemoteSnapshot;
};

export type CurrentReviewSession = {
  readonly profile: WorkspaceProfileConfig;
  readonly review: Review;
  readonly session: ReviewSession;
};

export type ReviewWriteExpectation = {
  readonly sessionId: ReviewSession["id"];
  readonly headSha: ReviewSession["key"]["headSha"];
  readonly patchHash: ContentHash;
  readonly draftRevision?: IsoTimestamp;
};

/** Shared precondition for every operation that can mutate GitHub or review state. */
export class ReviewWriteGate {
  constructor(
    private readonly profiles: Pick<ProfileStore, "load">,
    private readonly reviews: Pick<ReviewStore, "load"> & Partial<Pick<ReviewStore, "list">>,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly remote: Pick<ReviewRemoteStore, "load">,
  ) {}

  async hasReviewForSession(profileId: WorkspaceProfileId, sessionId: ReviewSessionId): Promise<Result<boolean, ReviewWriteGateFailure>> {
    if (this.reviews.list === undefined) return ok(false);
    const reviews = await this.reviews.list(profileId);
    if (reviews._tag === "err") return err({ reason: "storage" });
    return ok(reviews.value.some((review) => review.currentSessionId === sessionId));
  }

  /** Resolve the stable Review owner before recovery mutates session evidence. */
  async requireCurrentSession(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<CurrentReviewSession, ReviewWriteGateFailure>> {
    const [profile, review] = await Promise.all([
      this.profiles.load(profileId),
      this.reviews.load(profileId, reviewId),
    ]);
    if (profile._tag === "err" && profile.error.reason === "not_found") return err({ reason: "not_found" });
    if (review._tag === "err" && review.error.reason === "not_found") return err({ reason: "not_found" });
    if (profile._tag === "err" || review._tag === "err") return err({ reason: "storage" });
    if (review.value.identity.profileId !== profileId || review.value.id !== reviewId) return err({ reason: "stale" });
    if (review.value.status._tag === "Terminal") return err({ reason: "terminal" });
    const session = await this.sessions.load(profileId, review.value.currentSessionId);
    if (session._tag === "err") return session.error.reason === "not_found" ? err({ reason: "not_found" }) : err({ reason: "storage" });
    if (
      session.value.key.profileId !== profileId ||
      session.value.key.host !== review.value.identity.host ||
      session.value.key.owner !== review.value.identity.owner ||
      session.value.key.repo !== review.value.identity.repo ||
      session.value.key.prNumber !== review.value.identity.prNumber ||
      session.value.key.headSha !== review.value.currentHeadSha
    ) return err({ reason: "stale" });
    return ok({ profile: profile.value, review: review.value, session: session.value });
  }

  async requireFresh(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    expected?: ReviewWriteExpectation,
  ): Promise<Result<FreshReview, ReviewWriteGateFailure>> {
    const [profile, review] = await Promise.all([
      this.profiles.load(profileId),
      this.reviews.load(profileId, reviewId),
    ]);
    if (profile._tag === "err" && profile.error.reason === "not_found") return err({ reason: "not_found" });
    if (review._tag === "err" && review.error.reason === "not_found") return err({ reason: "not_found" });
    if (profile._tag === "err" || review._tag === "err") return err({ reason: "storage" });
    const value = review.value;
    if (value.status._tag === "Terminal") return err({ reason: "terminal" });
    if (value.representedRemote === undefined || value.detectedUpdate !== undefined) return err({ reason: "not_fresh" });
    if (value.identity.profileId !== profileId || value.id !== reviewId) return err({ reason: "stale" });
    const session = await this.sessions.load(profileId, value.currentSessionId);
    if (session._tag === "err") return session.error.reason === "not_found" ? err({ reason: "not_found" }) : err({ reason: "storage" });
    const snapshot = await this.remote.load({
      profileId,
      reviewId,
      snapshotHash: value.representedRemote.snapshotHash,
    });
    if (snapshot._tag === "err") return err({ reason: "stale" });
    const snapshotRef = snapshot.value.pullRequest.ref;
    if (
      snapshot.value.pullRequest.headSha !== value.representedRemote.headSha ||
      snapshotRef.host !== value.identity.host ||
      snapshotRef.owner !== value.identity.owner ||
      snapshotRef.repo !== value.identity.repo ||
      snapshotRef.number !== value.identity.prNumber
    ) return err({ reason: "stale" });
    if (
      session.value.key.profileId !== profileId ||
      session.value.key.host !== value.identity.host ||
      session.value.key.owner !== value.identity.owner ||
      session.value.key.repo !== value.identity.repo ||
      session.value.key.prNumber !== value.identity.prNumber ||
      session.value.key.headSha !== value.currentHeadSha ||
      session.value.key.headSha !== value.representedRemote.headSha
    ) return err({ reason: "stale" });
    if (expected !== undefined) {
      if (expected.sessionId !== session.value.id || expected.headSha !== session.value.key.headSha) return err({ reason: "stale" });
      const patchHash = await contentHash(session.value.patchPath).catch(() => undefined);
      if (patchHash === undefined || patchHash !== expected.patchHash) return err({ reason: "stale" });
      if (expected.draftRevision !== undefined && session.value.batchContent !== undefined && session.value.batchContent.updatedAt !== expected.draftRevision) return err({ reason: "stale" });
    }
    return ok({ profile: profile.value, review: value, session: session.value, snapshot: snapshot.value });
  }
}
