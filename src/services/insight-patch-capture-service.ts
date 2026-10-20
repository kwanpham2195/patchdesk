import { resolve } from "node:path";
import type {
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "#src/domain/ids";
import { sessionRepresentsReview } from "#src/domain/review";
import { ok } from "#src/domain/result";
import { ReviewStore } from "#src/adapters/storage/review-store";
import { ReviewSessionStore } from "#src/adapters/storage/review-session-store";
import { ProfileStore } from "#src/adapters/storage/profile-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import {
  patchCaptureFailure,
  type InsightPatchCaptureResult,
} from "#src/adapters/storage/insight-artifact-job-protocol";
import type { InsightResourceBundle } from "./insight-resource-bundle";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/** Stages only a verified patch TextRoot; no slot, journal, candidate or provider capability is held here. */
export class InsightPatchCaptureService {
  private readonly reviews: ReviewStore;
  private readonly sessions: ReviewSessionStore;
  private readonly profiles: ProfileStore;

  /** The caller supplies a newly isolated destination; source stores remain read-only. */
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly resources: InsightResourceBundle,
    private readonly operations: ReviewOperationCoordinator,
  ) {
    this.reviews = new ReviewStore(paths);
    this.sessions = new ReviewSessionStore(paths);
    this.profiles = new ProfileStore(paths);
  }

  /** Observes authority under short locks, holds the shared capture permit for bulk work, then rechecks authority. */
  async stage(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    revision: string,
    sessionId: ReviewSessionId,
    expectedHash: string,
    destination: PatchdeskPaths,
    options: { readonly signal?: AbortSignal },
  ): Promise<InsightPatchCaptureResult> {
    const observe = () =>
      this.operations.withReviewLock(profileId, reviewId, async () => {
        if (options.signal?.aborted) return patchCaptureFailure("aborted");
        const [profile, review] = await Promise.all([
          this.profiles.load(profileId),
          this.reviews.load(profileId, reviewId),
        ]);
        if (
          profile._tag === "err" ||
          profile.value.id !== profileId ||
          review._tag === "err"
        )
          return patchCaptureFailure("invalid_source");
        if (
          review.value.status._tag !== "Open" ||
          review.value.updatedAt !== revision ||
          review.value.currentSessionId !== sessionId
        )
          return patchCaptureFailure("stale_source");
        const session = await this.sessions.load(profileId, sessionId);
        if (
          session._tag === "err" ||
          !sessionRepresentsReview(review.value, session.value)
        )
          return patchCaptureFailure("invalid_source");
        const sourcePath = this.paths.patchFile(profileId, sessionId);
        // The worker verifies actual source bytes even when the optional stored hash is absent.
        if (
          (session.value.canonicalPatchHash !== undefined &&
            session.value.canonicalPatchHash !== expectedHash) ||
          resolve(session.value.patchPath) !== resolve(sourcePath)
        )
          return patchCaptureFailure("stale_source");
        return ok({ sourcePath, sessionUpdatedAt: session.value.updatedAt });
      });
    const before = await observe();
    if (before._tag === "err") return before;
    const permit = await this.resources.permits.capture(
      `patch-diagnostic:${profileId}:${reviewId}`,
      options.signal,
    );
    if (permit._tag === "err")
      return patchCaptureFailure(
        permit.error === "aborted" ? "aborted" : "busy",
      );
    try {
      const result = await this.resources.jobs.capturePatch(
        {
          sourceRoot: this.paths.dataDirectory(),
          sourcePath: before.value.sourcePath,
          destinationRoot: destination.dataDirectory(),
          destinationReview: destination.reviewDirectory(profileId, reviewId),
          profileId,
          reviewId,
          sessionId,
          expectedHash,
        },
        options,
      );
      if (result._tag === "err") return result;
      const after = await observe();
      if (after._tag === "err") return after;
      return after.value.sessionUpdatedAt === before.value.sessionUpdatedAt &&
        !options.signal?.aborted
        ? result
        : patchCaptureFailure(
            options.signal?.aborted ? "aborted" : "stale_source",
          );
    } finally {
      permit.value.release();
    }
  }
}
