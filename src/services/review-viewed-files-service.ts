import type { ReviewStore } from "../adapters/storage/review-store";
import type { ViewedFilesStore } from "../adapters/storage/viewed-files-store";
import type {
  RepoRelativePath,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

export type ViewedFilesFailure = {
  readonly reason: "not_found" | "stale_head" | "storage";
};

/** Saves the Viewed marks of a Review's current session under the Review lock. */
export class ReviewViewedFilesService {
  constructor(
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly viewedFiles: Pick<ViewedFilesStore, "save">,
    private readonly operations: Pick<
      ReviewOperationCoordinator,
      "withReviewLock"
    >,
  ) {}

  async save(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly sessionId: ReviewSessionId;
    readonly paths: ReadonlyArray<RepoRelativePath>;
  }): Promise<
    Result<
      { readonly paths: ReadonlyArray<RepoRelativePath> },
      ViewedFilesFailure
    >
  > {
    return this.operations.withReviewLock(
      input.profileId,
      input.reviewId,
      async () => {
        // Marks are the reviewer's own reading progress, so a merged or closed Review keeps them editable.
        const review = await this.reviews.load(input.profileId, input.reviewId);
        if (review._tag === "err")
          return err({
            reason:
              review.error.reason === "not_found" ? "not_found" : "storage",
          });
        // A session the Review no longer represents belongs to an old head; its marks are not carried forward.
        if (review.value.currentSessionId !== input.sessionId)
          return err({ reason: "stale_head" });
        const saved = await this.viewedFiles.save(
          input.profileId,
          input.sessionId,
          input.paths,
        );
        return saved._tag === "ok"
          ? ok({ paths: saved.value })
          : err({ reason: "storage" });
      },
    );
  }
}
