/** The review fields baseline selection reads; the renderer and the main process pass their own typings of them. */
type SubmittedReview = {
  readonly author: string;
  readonly submittedAt: string;
  readonly commitId?: string | undefined;
};

/**
 * Where "Since your review" diffs from: the head commit of the viewer's last
 * submitted GitHub review on this pull request.
 */
export type SinceReviewBaseline<Sha extends string = string> =
  | { readonly _tag: "NoReview" }
  | { readonly _tag: "CurrentHead" }
  /** The reviewed commit left the pull request's history, as after a force-push. */
  | { readonly _tag: "Unreachable"; readonly commitSha: Sha }
  | { readonly _tag: "Available"; readonly commitSha: Sha };

/** Picks the viewer's latest submitted review and says whether its commit can still be diffed against the head. */
export function selectSinceReviewBaseline<
  Review extends SubmittedReview,
>(input: {
  readonly reviews: ReadonlyArray<Review>;
  readonly viewerLogin: string;
  readonly headSha: string;
  readonly commits: ReadonlyArray<{ readonly sha: string }>;
}): SinceReviewBaseline<NonNullable<Review["commitId"]>> {
  const viewer = input.viewerLogin.toLowerCase();
  let latest: Review | undefined;
  for (const review of input.reviews) {
    if (review.author.toLowerCase() !== viewer || review.commitId === undefined)
      continue;
    if (latest === undefined || review.submittedAt > latest.submittedAt)
      latest = review;
  }
  // SAFETY: the loop above keeps only reviews whose `commitId` is defined.
  const commitSha = latest?.commitId as
    | NonNullable<Review["commitId"]>
    | undefined;
  if (commitSha === undefined) return { _tag: "NoReview" };
  if (commitSha === input.headSha) return { _tag: "CurrentHead" };
  // A commit outside the pull request's own list is not an ancestor of the head, so the diff would mix in unrelated history.
  return input.commits.some((commit) => commit.sha === commitSha)
    ? { _tag: "Available", commitSha }
    : { _tag: "Unreachable", commitSha };
}
