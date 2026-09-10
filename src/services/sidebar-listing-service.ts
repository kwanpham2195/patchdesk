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

/**
 * The state a pull request finished in, dated with the moment Patchdesk
 * observed it. The date travels with the state so the row can say when it was
 * seen instead of implying the state is live.
 */
type SidebarTerminalState = {
  readonly state: "merged" | "closed";
  readonly observedAt: IsoTimestamp;
};

/** One visited pull request, as the sidebar renders it. */
type SidebarReviewRow = {
  readonly reviewId: ReviewId;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly number: PullRequestNumber;
  readonly title?: string;
  /** What the column orders and date-groups by. A guess is allowed here. */
  readonly sortedAt: IsoTimestamp;
  /**
   * When the maintainer last opened this pull request in Patchdesk, absent on a
   * record stored before Patchdesk recorded opens. The row prints an age only
   * from this, so it can never date a visit that never happened.
   */
  readonly lastOpenedAt?: IsoTimestamp;
  /** Absent while the pull request is still open. */
  readonly terminal?: SidebarTerminalState;
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
      .sort((left, right) => sortedAt(right).localeCompare(sortedAt(left)))
      .slice(0, SIDEBAR_ROW_LIMIT)
      .map((review): SidebarReviewRow => ({
        reviewId: review.id,
        owner: review.identity.owner,
        repo: review.identity.repo,
        number: review.identity.prNumber,
        // An empty stored title is no title: the renderer's row schema requires
        // a non-empty string, and one such row must not fail the whole parse.
        ...definedProps({
          title: review.title === "" ? undefined : review.title,
          terminal: terminalState(review),
          lastOpenedAt: review.lastOpenedAt,
        }),
        sortedAt: sortedAt(review),
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
 * Where a row sits in the list. `updatedAt` stands in for a Review written
 * before `lastOpenedAt` shipped, so a record from an earlier build still lands
 * somewhere sensible. GitHub activity bumps `updatedAt`, so this instant is a
 * guess about the visit and never reaches the row as an age.
 */
function sortedAt(review: Review): IsoTimestamp {
  return review.lastOpenedAt ?? review.updatedAt;
}

/**
 * The Terminal state already stored on the Review, or nothing while it is
 * Open. This reads what the record holds and calls no one: a row never
 * recomputes a pull request's state.
 */
function terminalState(review: Review): SidebarTerminalState | undefined {
  const { status } = review;
  if (status._tag !== "Terminal") return undefined;
  return { state: status.state, observedAt: status.observedAt };
}
