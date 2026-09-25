import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { ReviewStore } from "../adapters/storage/review-store";
import {
  createReviewId,
  type IsoTimestamp,
  type LocalBranchName,
  type ReviewId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { casesHandled, err, type Result } from "../domain/result";
import {
  createReview,
  isLocalReview,
  markReviewOpened,
  moveLocalReviewToSession,
  type Review,
} from "../domain/review";
import { definedProps } from "../domain/defined-props";
import type {
  LocalReviewSource,
  LocalReviewSourceRequest,
} from "../domain/review-source";
import type {
  LocalReviewOpenRequest,
  LocalReviewPreparationFailure,
  LocalReviewSessionPreparation,
  ResolvedLocalReview,
} from "./local-review-session-preparation";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type {
  ReviewWorkbenchProjection,
  ReviewWorkbenchProjectionService,
} from "./review-workbench-projection";

export type LocalReviewOpenFailure =
  | {
      readonly reason:
        | "not_found"
        | "repository_not_local"
        | "unmerged_index"
        | "revision_not_found"
        | "storage"
        | "terminal";
    }
  /** The checkout's `HEAD` is not the one the request expects; `currentBranch` is absent when it is detached. */
  | {
      readonly reason: "branch_mismatch";
      readonly currentBranch?: LocalBranchName;
    };

/**
 * Opens a local Review (ADR 0050). Every open reads the source from the
 * checkout again, so unchanged content lands on the same session and an edit
 * moves the Review to a new one.
 */
export class LocalReviewOpening {
  constructor(
    private readonly preparation: Pick<
      LocalReviewSessionPreparation,
      "resolve" | "prepare"
    >,
    private readonly projection: Pick<
      ReviewWorkbenchProjectionService,
      "loadLocal"
    >,
    private readonly lifecycle: {
      readonly reviews: Pick<ReviewStore, "load" | "save">;
      readonly artifacts: Pick<ReviewArtifactStorage, "quarantineReview">;
      readonly coordinator: Pick<ReviewOperationCoordinator, "withReviewLock">;
    },
    private readonly now: () => IsoTimestamp,
  ) {}

  async open(
    request: LocalReviewOpenRequest,
  ): Promise<Result<ReviewWorkbenchProjection, LocalReviewOpenFailure>> {
    // A branch switch between the unlocked read and the locked one keys
    // another Review, so the open starts once more under that Review's lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Reading the source decides the Review id: a working tree is keyed by the branch `HEAD` names.
      const resolved = await this.preparation.resolve(request);
      if (resolved._tag === "err")
        return err(mapPreparationFailure(resolved.error));
      // The locked open proceeds only on this same Review id, and a working
      // tree's id is keyed by its branch, so checking here also holds under the lock.
      const mismatch = headMismatch(
        request.request,
        resolved.value.identity.source,
      );
      if (mismatch !== undefined) return err(mismatch);
      const reviewId = createReviewId(resolved.value.identity);
      const opened = await this.lifecycle.coordinator.withReviewLock(
        request.profileId,
        reviewId,
        async () => {
          const result = await this.openLocked(request, reviewId);
          if (result?._tag === "ok")
            await this.recordOpened(request.profileId, reviewId);
          return result;
        },
      );
      if (opened !== undefined) return opened;
    }
    return err({ reason: "storage" });
  }

  /**
   * Stamps `lastOpenedAt` for the sidebar (ADR 0042) only on a maintainer's
   * open, so the reopen after an Apply leaves the order alone. Best effort:
   * the open has already succeeded, so a failed save is dropped.
   */
  private async recordOpened(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<void> {
    const loaded = await this.lifecycle.reviews.load(profileId, reviewId);
    if (loaded._tag === "err") return;
    await this.lifecycle.reviews.save(
      markReviewOpened(loaded.value, { now: this.now() }),
      loaded.value.updatedAt,
    );
  }

  /**
   * Reads the source again and moves the Review to that session. The caller
   * holds the Review lock for `reviewId`, because a snapshot read before the
   * lock can be older than a session another open saved meanwhile (#451).
   * Undefined when the checkout now keys a different Review.
   */
  async openLocked(
    request: LocalReviewOpenRequest,
    reviewId: ReviewId,
  ): Promise<
    Result<ReviewWorkbenchProjection, LocalReviewOpenFailure> | undefined
  > {
    const resolved = await this.preparation.resolve(request);
    if (resolved._tag === "err")
      return err(mapPreparationFailure(resolved.error));
    if (createReviewId(resolved.value.identity) !== reviewId) return undefined;
    return this.moveToSession(resolved.value, reviewId);
  }

  private async moveToSession(
    resolved: ResolvedLocalReview,
    reviewId: ReviewId,
  ): Promise<Result<ReviewWorkbenchProjection, LocalReviewOpenFailure>> {
    const { profileId } = resolved.identity;
    const session = await this.preparation.prepare(resolved);
    if (session._tag === "err")
      return err(mapPreparationFailure(session.error));
    const existing = await this.lifecycle.reviews.load(profileId, reviewId);
    let stored: Review<LocalReviewSource> | undefined;
    if (existing._tag === "ok") {
      if (!isLocalReview(existing.value)) return err({ reason: "storage" });
      stored = existing.value;
    } else if (existing.error.reason === "invalid_stored_value") {
      // A corrupt Review record is moved aside and rebuilt from the checkout.
      const quarantined = await this.lifecycle.artifacts.quarantineReview(
        profileId,
        reviewId,
      );
      if (quarantined._tag === "err") return err({ reason: "storage" });
    } else if (existing.error.reason !== "not_found") {
      return err({ reason: "storage" });
    }
    const now = this.now();
    const moved = moveLocalReviewToSession(
      stored ??
        createReview({
          identity: resolved.identity,
          currentSessionId: session.value.id,
          headSha: session.value.key.headSha,
          createdAt: now,
        }),
      {
        sessionId: session.value.id,
        headSha: session.value.key.headSha,
        updatedAt: now,
      },
    );
    if (moved._tag === "err") return err({ reason: "terminal" });
    const saved = await this.lifecycle.reviews.save(
      moved.value,
      stored?.updatedAt,
    );
    if (saved._tag === "err") return err({ reason: "storage" });
    const projected = await this.projection.loadLocal({
      profileId,
      sessionId: session.value.id,
      refreshedAt: moved.value.updatedAt,
      freshness: moved.value.freshness,
    });
    return projected._tag === "ok"
      ? projected
      : err({
          reason:
            projected.error._tag === "SessionStorageUnavailable"
              ? "storage"
              : "not_found",
        });
  }
}

function headMismatch(
  request: LocalReviewSourceRequest,
  source: LocalReviewSource,
): LocalReviewOpenFailure | undefined {
  if (request.kind !== "working_tree" || request.expectedHead === undefined)
    return undefined;
  if (source.kind !== "working_tree") return undefined;
  const expected =
    request.expectedHead.kind === "branch"
      ? request.expectedHead.branch
      : undefined;
  if (source.branch === expected) return undefined;
  return {
    reason: "branch_mismatch",
    ...definedProps({ currentBranch: source.branch }),
  };
}

function mapPreparationFailure(
  failure: LocalReviewPreparationFailure,
): LocalReviewOpenFailure {
  switch (failure._tag) {
    case "ProfileNotFound":
      return { reason: "not_found" };
    case "RepositoryNotLocal":
      return { reason: "repository_not_local" };
    case "UnmergedIndex":
      return { reason: "unmerged_index" };
    case "LocalRevisionNotFound":
      return { reason: "revision_not_found" };
    case "ProfileUnavailable":
    case "LocalGitFailed":
    case "SessionStorageUnavailable":
    case "PreparationUnavailable":
    case "PreparationCleanupUnavailable":
      return { reason: "storage" };
    default:
      return casesHandled(failure);
  }
}
