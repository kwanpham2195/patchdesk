import type {
  CheckSummary,
  GitHubLabel,
  PullRequestSummary,
} from "./github-context";
import type { GitSha, IsoTimestamp, ReviewId } from "./ids";
import type { PullRequestRef } from "./pull-request";

/** The only page sizes the main process accepts. */
export const INBOX_PAGE_SIZES = [10, 25, 50] as const;

/** A maintainer-selected inbox page size; rejected outside this bounded set. */
export type InboxPageSize = (typeof INBOX_PAGE_SIZES)[number];

/** The page size an inbox request carries when the caller does not choose one. */
export const DEFAULT_INBOX_PAGE_SIZE: InboxPageSize = 25;

/** Trusted inbox scopes map to the only GraphQL pull-request states Patchdesk requests. */
export type InboxScope = "open" | "merged";

/** Parsed inbox pagination intent; page tokens remain opaque outside the main process. */
export type InboxPageRequest = {
  readonly scope: InboxScope;
  readonly pageSize: InboxPageSize;
  readonly pageToken?: string;
};

export type InboxCategory = "updated_since_review" | "ready_to_merge";

export type InboxRecommendedAction =
  | { readonly kind: "run_review"; readonly label: "Run review" }
  | {
      readonly kind: "open_merged_review";
      readonly label: "View merged pull request";
    }
  | {
      readonly kind: "open_saved_review";
      readonly label: "Open Review";
      readonly reviewId: ReviewId;
    }
  | {
      readonly kind: "open_merge_readiness";
      readonly label: "Open merge readiness";
      readonly reviewId: ReviewId;
    };

export type InboxReviewSummary = {
  readonly reviewId: ReviewId;
  readonly reviewedHeadSha: GitSha;
  readonly updatedAt: IsoTimestamp;
  readonly matchesCurrentHead: boolean;
};

export type MaintainerInboxRow = {
  /** Confirmed remote scope for this row; merged rows never enter active-work queues. */
  readonly remoteState: InboxScope;
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
  readonly labels: ReadonlyArray<GitHubLabel>;
  readonly labelCount?: number;
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
  if (!input.summary.isOpen) return projectMergedMaintainerInboxRow(input);
  const categories: Array<InboxCategory> = [];
  const review = input.latestReview;
  if (review !== undefined && !review.matchesCurrentHead)
    categories.push("updated_since_review");
  if (
    input.dataFreshness === "fresh" &&
    review?.matchesCurrentHead &&
    input.summary.mergeability === "mergeable" &&
    input.checks.overall === "passing"
  )
    categories.push("ready_to_merge");

  const reviewField = review === undefined ? {} : { review };
  const recommendedAction = recommendedActionFor({
    categories,
    ...reviewField,
    dataFreshness: input.dataFreshness,
  });
  const additionsField =
    input.summary.additions === undefined
      ? {}
      : { additions: input.summary.additions };
  const deletionsField =
    input.summary.deletions === undefined
      ? {}
      : { deletions: input.summary.deletions };
  const changedFilesField =
    input.summary.changedFileCount === undefined
      ? {}
      : { changedFiles: input.summary.changedFileCount };
  const latestReviewField =
    review === undefined ? {} : { latestReview: review };
  const labelCountField =
    input.summary.labelCount === undefined
      ? {}
      : { labelCount: input.summary.labelCount };
  return {
    remoteState: "open",
    identity: input.summary.ref,
    title: input.summary.title,
    author: input.summary.author,
    baseBranch: input.summary.baseBranch,
    headBranch: input.summary.headBranch,
    currentHeadSha: input.summary.headSha,
    isDraft: input.summary.isDraft,
    updatedAt: input.summary.updatedAt,
    changeStats: {
      ...additionsField,
      ...deletionsField,
      ...changedFilesField,
    },
    checks: input.checks,
    reviewState: input.summary.reviewState,
    mergeability: input.summary.mergeability,
    ...latestReviewField,
    labels: input.summary.labels,
    ...labelCountField,
    categories,
    recommendedAction,
    dataFreshness: input.dataFreshness,
  };
}

function projectMergedMaintainerInboxRow(input: {
  readonly summary: PullRequestSummary;
  readonly checks: CheckSummary;
  readonly dataFreshness: "fresh" | "cached";
}): MaintainerInboxRow {
  const additionsField =
    input.summary.additions === undefined
      ? {}
      : { additions: input.summary.additions };
  const deletionsField =
    input.summary.deletions === undefined
      ? {}
      : { deletions: input.summary.deletions };
  const changedFilesField =
    input.summary.changedFileCount === undefined
      ? {}
      : { changedFiles: input.summary.changedFileCount };
  const labelCountField =
    input.summary.labelCount === undefined
      ? {}
      : { labelCount: input.summary.labelCount };
  return {
    remoteState: "merged",
    identity: input.summary.ref,
    title: input.summary.title,
    author: input.summary.author,
    baseBranch: input.summary.baseBranch,
    headBranch: input.summary.headBranch,
    currentHeadSha: input.summary.headSha,
    isDraft: input.summary.isDraft,
    updatedAt: input.summary.updatedAt,
    changeStats: { ...additionsField, ...deletionsField, ...changedFilesField },
    checks: input.checks,
    reviewState: input.summary.reviewState,
    mergeability: input.summary.mergeability,
    labels: input.summary.labels,
    ...labelCountField,
    categories: [],
    recommendedAction: {
      kind: "open_merged_review",
      label: "View merged pull request",
    },
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
  return { kind: "run_review", label: "Run review" };
}
