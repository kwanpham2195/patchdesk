import type { CheckSummary, PullRequestSummary } from "./github-context";
import type { GitSha, IsoTimestamp, ReviewId } from "./ids";
import type { PullRequestRef } from "./pull-request";

export type InboxCategory =
  | "needs_review"
  | "updated_since_review"
  | "waiting_for_author"
  | "checks_failing"
  | "checks_pending"
  | "ready_to_merge"
  | "draft"
  | "authored"
  | "saved_review";

export type InboxRecommendedAction =
  | { readonly kind: "run_review"; readonly label: "Run review" }
  | {
      readonly kind: "open_saved_review";
      readonly label: "Open Review";
      readonly reviewId: ReviewId;
    }
  | {
      readonly kind: "open_merge_readiness";
      readonly label: "Open merge readiness";
      readonly reviewId: ReviewId;
    }
  | {
      readonly kind: "open_discussion";
      readonly label: "Review author response";
      readonly reviewId: ReviewId;
    };

export type InboxReviewSummary = {
  readonly reviewId: ReviewId;
  readonly reviewedHeadSha: GitSha;
  readonly updatedAt: IsoTimestamp;
  readonly matchesCurrentHead: boolean;
};

export type MaintainerInboxRow = {
  readonly identity: PullRequestRef;
  readonly title: string;
  readonly author: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly currentHeadSha: GitSha;
  readonly isDraft: boolean;
  readonly updatedAt: IsoTimestamp;
  readonly changeStats: {
    readonly additions?: number;
    readonly deletions?: number;
    readonly changedFiles?: number;
  };
  readonly checks: CheckSummary;
  readonly reviewState: PullRequestSummary["reviewState"];
  readonly mergeability: PullRequestSummary["mergeability"];
  readonly latestReview?: InboxReviewSummary;
  readonly categories: ReadonlyArray<InboxCategory>;
  readonly recommendedAction: InboxRecommendedAction;
  readonly dataFreshness: "fresh" | "cached";
};

/** Project one PR into overlapping queue categories and one truthful primary action. */
export function projectMaintainerInboxRow(input: {
  readonly summary: PullRequestSummary;
  readonly checks: CheckSummary;
  readonly activeAccount: string;
  readonly latestReview?: InboxReviewSummary;
  readonly dataFreshness: "fresh" | "cached";
}): MaintainerInboxRow {
  const categories: Array<InboxCategory> = [];
  const review = input.latestReview;
  const requested =
    input.summary.requestedReviewers?.includes(input.activeAccount) === true;
  if (requested) categories.push("needs_review");
  if (review !== undefined && !review.matchesCurrentHead)
    categories.push("updated_since_review");
  if (
    review?.matchesCurrentHead &&
    input.summary.reviewState === "changes_requested"
  )
    categories.push("waiting_for_author");
  if (input.checks.overall === "failing") categories.push("checks_failing");
  if (input.checks.overall === "pending") categories.push("checks_pending");
  if (input.summary.isDraft) categories.push("draft");
  if (input.summary.author === input.activeAccount) categories.push("authored");
  if (review?.matchesCurrentHead) categories.push("saved_review");
  if (
    input.dataFreshness === "fresh" &&
    review?.matchesCurrentHead &&
    input.summary.mergeability === "mergeable" &&
    input.checks.overall === "passing"
  )
    categories.push("ready_to_merge");

  const recommendedAction = recommendedActionFor({
    categories,
    ...(review === undefined ? {} : { review }),
    dataFreshness: input.dataFreshness,
  });
  return {
    identity: input.summary.ref,
    title: input.summary.title,
    author: input.summary.author,
    baseBranch: input.summary.baseBranch,
    headBranch: input.summary.headBranch,
    currentHeadSha: input.summary.headSha,
    isDraft: input.summary.isDraft,
    updatedAt: input.summary.updatedAt,
    changeStats: {
      ...(input.summary.additions === undefined
        ? {}
        : { additions: input.summary.additions }),
      ...(input.summary.deletions === undefined
        ? {}
        : { deletions: input.summary.deletions }),
      ...(input.summary.changedFileCount === undefined
        ? {}
        : { changedFiles: input.summary.changedFileCount }),
    },
    checks: input.checks,
    reviewState: input.summary.reviewState,
    mergeability: input.summary.mergeability,
    ...(review === undefined ? {} : { latestReview: review }),
    categories,
    recommendedAction,
    dataFreshness: input.dataFreshness,
  };
}

function recommendedActionFor(input: {
  readonly categories: ReadonlyArray<InboxCategory>;
  readonly review?: InboxReviewSummary;
  readonly dataFreshness: "fresh" | "cached";
}): InboxRecommendedAction {
  if (
    input.review !== undefined &&
    input.categories.includes("updated_since_review")
  )
    return {
      kind: "open_saved_review",
      label: "Open Review",
      reviewId: input.review.reviewId,
    };
  if (input.review?.matchesCurrentHead)
    return {
      kind: "open_saved_review",
      label: "Open Review",
      reviewId: input.review.reviewId,
    };
  if (
    input.dataFreshness === "fresh" &&
    input.categories.includes("ready_to_merge") &&
    input.review !== undefined
  )
    return {
      kind: "open_merge_readiness",
      label: "Open merge readiness",
      reviewId: input.review.reviewId,
    };
  if (input.categories.includes("needs_review"))
    return { kind: "run_review", label: "Run review" };
  if (
    input.categories.includes("waiting_for_author") &&
    input.review !== undefined
  )
    return {
      kind: "open_discussion",
      label: "Review author response",
      reviewId: input.review.reviewId,
    };
  return { kind: "run_review", label: "Run review" };
}
