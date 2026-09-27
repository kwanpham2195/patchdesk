import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import { definedProps } from "../domain/defined-props";
import type {
  AbsolutePath,
  IsoTimestamp,
  LocalBranchName,
  WorkspaceProfileId,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { isLocalReview, type Review } from "../domain/review";
import type { LocalReviewSource } from "../domain/review-source";
import type { RepositoryCheckout } from "./local-checkout";
import type { LocalReviewOpenRequest } from "./local-review-session-preparation";
import {
  describeCurrentSession,
  type ReviewSessionDescription,
} from "./review-session-description";

/** An open shared Review of a checkout on its current session, as `list_local_reviews` names it. */
type ListedSharedReview = ReviewSessionDescription & {
  readonly branch: LocalBranchName;
  readonly baseBranch: LocalBranchName;
  /** When the maintainer last opened it; absent when only an agent has. */
  readonly lastOpenedAt?: IsoTimestamp;
};

/** The branch a checkout is on and its open shared Reviews on any branch, the one opened last first (ADR 0052 `list_local_reviews`). */
export type CheckoutSharedReviews = {
  readonly head: RepositoryCheckout["head"];
  readonly reviews: ReadonlyArray<ListedSharedReview>;
};

type OpenSharedReview = {
  readonly review: Review<LocalReviewSource>;
  readonly source: Extract<
    LocalReviewSource,
    { readonly kind: "local_branch" }
  >;
};

/**
 * The open shared Reviews of a repository's checkout, `checkout` in its
 * stored form (absent for the configured one), on `branch` when given, the
 * one the maintainer opened last first. The dialog's bases, an agent's reused
 * base, and `list_local_reviews` all read this one list. It only reads.
 */
export async function listOpenSharedReviews(
  reviews: Pick<ReviewStore, "list">,
  profileId: WorkspaceProfileId,
  repository: LocalReviewOpenRequest["repository"],
  checkout: AbsolutePath | undefined,
  branch?: LocalBranchName,
): Promise<
  Result<ReadonlyArray<OpenSharedReview>, { readonly reason: "storage" }>
> {
  const listed = await reviews.list(profileId);
  if (listed._tag === "err") return err({ reason: "storage" });
  const shared: Array<OpenSharedReview> = [];
  for (const review of listed.value.reviews) {
    if (!isLocalReview(review) || review.status._tag === "Terminal") continue;
    const { host, owner, repo, source } = review.identity;
    if (
      source.kind === "local_branch" &&
      (branch === undefined || source.branch === branch) &&
      source.checkout === checkout &&
      host === repository.host &&
      owner === repository.owner &&
      repo === repository.repo
    )
      shared.push({ review, source });
  }
  const openedAt = ({ review }: OpenSharedReview) =>
    review.lastOpenedAt ?? review.updatedAt;
  return ok(
    shared.sort((left, right) => openedAt(right).localeCompare(openedAt(left))),
  );
}

/** Each Review on its current session; one whose session cannot be read refuses the whole list, so no Review the maintainer means is hidden. */
export async function describeSharedReviews(
  sessions: Pick<ReviewSessionStore, "load">,
  shared: ReadonlyArray<OpenSharedReview>,
): Promise<
  Result<ReadonlyArray<ListedSharedReview>, { readonly reason: "storage" }>
> {
  const described: Array<ListedSharedReview> = [];
  for (const { review, source } of shared) {
    const session = await describeCurrentSession(sessions, review);
    if (session._tag === "err") return session;
    described.push({
      ...session.value,
      branch: source.branch,
      baseBranch: source.baseBranch,
      ...definedProps({ lastOpenedAt: review.lastOpenedAt }),
    });
  }
  return ok(described);
}
