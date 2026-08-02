import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { Review } from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";

export type ReviewWriteGateFailure = {
  readonly reason: "not_found" | "storage" | "stale" | "terminal" | "not_fresh";
};

export type FreshReview = {
  readonly profile: WorkspaceProfileConfig;
  readonly review: Review;
  readonly session: ReviewSession;
};

/** Shared precondition for every operation that can mutate GitHub or review state. */
export class ReviewWriteGate {
  constructor(
    private readonly profiles: Pick<ProfileStore, "load">,
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly remote: Pick<ReviewRemoteStore, "load">,
  ) {}

  async requireFresh(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
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
    return ok({ profile: profile.value, review: value, session: session.value });
  }
}
