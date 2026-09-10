import type { ReviewStore } from "../adapters/storage/review-store";
import { definedProps } from "../domain/defined-props";
import type {
  GitHubOwner,
  GitHubRepoName,
  IsoTimestamp,
  PullRequestNumber,
  ReviewId,
  WorkspaceProfileId,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { Review } from "../domain/review";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";

/** How many visited pull requests the sidebar shows. */
const SIDEBAR_ROW_LIMIT = 20;

/** One visited pull request, as the sidebar renders it. */
type SidebarReviewRow = {
  readonly reviewId: ReviewId;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly number: PullRequestNumber;
  readonly title?: string;
  readonly openedAt: IsoTimestamp;
};

/** The sidebar's rows, plus how many stored Reviews could not be read. */
export type SidebarListing = {
  readonly rows: ReadonlyArray<SidebarReviewRow>;
  readonly unreadable: number;
};

export type SidebarListingFailure = { readonly reason: "storage" };

export type SidebarListingDependencies = {
  readonly reviews: Pick<ReviewStore, "list">;
  readonly diagnostics: Pick<ReviewDiagnosticService, "record">;
};

/**
 * Projects one workspace profile's visited pull requests into the sidebar's
 * rows, most recently opened first.
 *
 * `ReviewStore.list` has no index: it opens every review file under the
 * profile, so this runs on demand for one profile rather than eagerly or
 * across every profile.
 */
export class SidebarListingService {
  constructor(private readonly dependencies: SidebarListingDependencies) {}

  async list(
    profileId: WorkspaceProfileId,
  ): Promise<Result<SidebarListing, SidebarListingFailure>> {
    const listing = await this.dependencies.reviews.list(profileId);
    if (listing._tag === "err") return err({ reason: "storage" });

    const { reviews, unreadable } = listing.value;
    if (unreadable > 0) await this.recordUnreadable(profileId, unreadable);

    const rows = [...reviews]
      .sort((left, right) => openedAt(right).localeCompare(openedAt(left)))
      .slice(0, SIDEBAR_ROW_LIMIT)
      .map((review): SidebarReviewRow => ({
        reviewId: review.id,
        owner: review.identity.owner,
        repo: review.identity.repo,
        number: review.identity.prNumber,
        ...definedProps({ title: review.title }),
        openedAt: openedAt(review),
      }));
    return ok({ rows, unreadable });
  }

  private async recordUnreadable(
    profileId: WorkspaceProfileId,
    unreadable: number,
  ): Promise<void> {
    try {
      await this.dependencies.diagnostics.record({
        profileId,
        category: "recovery",
        phase: "sidebar-listing-unreadable",
        retryable: true,
        detail: `unreadable_reviews=${unreadable}`,
      });
    } catch {
      // Diagnostics are best effort and never become an unhandled rejection.
    }
  }
}

/**
 * `updatedAt` stands in for Reviews written before `lastOpenedAt` shipped, so
 * a record from an earlier build still sorts and dates somewhere sensible.
 */
function openedAt(review: Review): IsoTimestamp {
  return review.lastOpenedAt ?? review.updatedAt;
}
