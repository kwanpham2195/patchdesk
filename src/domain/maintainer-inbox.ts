import type { ChangeScope } from "./change-scope";
import { definedProps } from "./defined-props";
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

/** The pull-request state an inbox listing is filtered to; maps to the only
 * GraphQL pull-request states Patchdesk requests. Named for `InboxFilter.state`,
 * the one spelling the domain, the route, and the renderer all use. */
export const INBOX_STATE_FILTER_VALUES = ["open", "merged"] as const;
export type InboxStateFilter = (typeof INBOX_STATE_FILTER_VALUES)[number];

/** Whether an inbox payload came from a live GitHub read or the on-disk cache. */
export const INBOX_DATA_FRESHNESS = ["fresh", "cached"] as const;
export type InboxDataFreshness = (typeof INBOX_DATA_FRESHNESS)[number];

/** How current the inbox rows on screen are, relative to GitHub. */
export const INBOX_SNAPSHOT_STATES = [
  "current",
  "partial",
  "failed_cached",
  "stale_cached",
  "unavailable",
] as const;
export type InboxSnapshotState = (typeof INBOX_SNAPSHOT_STATES)[number];

/** How one repository's slice of an inbox read finished. */
export const INBOX_REPOSITORY_OUTCOMES = [
  "ready",
  "no_open_prs",
  "github_auth",
  "github_read",
  "github_rate_limited",
  "github_forbidden",
] as const;
export type InboxRepositoryOutcome = (typeof INBOX_REPOSITORY_OUTCOMES)[number];

/** The only repository label filter GitHub's search API and Patchdesk's 256-character query cap can absorb; see `buildInboxSearchQuery`. */
export const MAX_INBOX_FILTER_LABELS = 5;
/** GitHub's own label-name length cap. */
export const MAX_INBOX_FILTER_LABEL_LENGTH = 50;

/**
 * A structured, enumerated inbox filter. Every field is validated at the
 * route the same way `scope` used to be — the renderer never sends a GitHub
 * search-qualifier string, only these bounded, enumerated-or-sanitized
 * values, so `buildInboxSearchQuery` (in `maintainer-inbox-service.ts`) stays
 * the one place free text can reach GitHub's search API.
 */
export type InboxFilter = {
  readonly state: InboxStateFilter;
  /** Repository label names, ANDed together as `label:"NAME"`. Capped at
   * `MAX_INBOX_FILTER_LABELS`, each within `MAX_INBOX_FILTER_LABEL_LENGTH`
   * and free of the double quote that would let one break out of its
   * qualifier — enforced at the route, not here. */
  readonly labels?: ReadonlyArray<string>;
  /** The "Awaiting review from you" preset from ADR 0031 — GitHub's
   * `user-review-requested:@me` qualifier, which GitHub itself resolves to
   * the authenticated viewer, so Patchdesk never looks the login up. A
   * filter preset, not a queue: it composes with `state` and `labels` rather
   * than replacing the listing. Unlike `labels` it is not
   * repository-scoped, so a repository change carries it over. */
  readonly awaitingMyReview?: boolean;
};

/** Presented together in the filter bar and the command palette; one list so the two surfaces cannot drift. */
export const INBOX_STATE_FILTERS: ReadonlyArray<{
  readonly state: InboxStateFilter;
  readonly label: string;
}> = [
  { state: "open", label: "Open pull requests" },
  { state: "merged", label: "Merged pull requests" },
];

/** Parsed inbox pagination intent; page tokens remain opaque outside the main process. */
export type InboxPageRequest = {
  readonly filter: InboxFilter;
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
  readonly remoteState: InboxStateFilter;
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
  /**
   * Present only when Patchdesk already holds a Review session whose retained
   * patch describes this row's current head. GitHub's inbox query returns
   * totals but no per-file lines, so a row Patchdesk has never reviewed has
   * nothing to bucket and shows no gauge rather than a guessed one.
   */
  readonly scope?: ChangeScope;
  /**
   * Present only when Patchdesk holds a Brief retained for this row's current
   * head. Absent, rather than `false`, for every other row: the tag says a
   * Brief is there to read, and a row that has never been reviewed has no
   * claim to make either way.
   */
  readonly briefReady?: true;
  readonly latestReview?: InboxReviewSummary;
  readonly labels: ReadonlyArray<GitHubLabel>;
  readonly labelCount?: number;
  readonly categories: ReadonlyArray<InboxCategory>;
  readonly recommendedAction: InboxRecommendedAction;
  readonly dataFreshness: InboxDataFreshness;
};

/** Project one PR into overlapping queue categories and one truthful primary action. */
export function projectMaintainerInboxRow(input: {
  readonly summary: PullRequestSummary;
  readonly checks: CheckSummary;
  readonly activeAccount: string;
  readonly latestReview?: InboxReviewSummary;
  readonly scope?: ChangeScope;
  readonly briefReady?: true;
  readonly dataFreshness: InboxDataFreshness;
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
  const scopeField = input.scope === undefined ? {} : { scope: input.scope };
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
    ...scopeField,
    ...definedProps({ briefReady: input.briefReady }),
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
  readonly scope?: ChangeScope;
  readonly briefReady?: true;
  readonly dataFreshness: InboxDataFreshness;
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
  const scopeField = input.scope === undefined ? {} : { scope: input.scope };
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
    ...scopeField,
    ...definedProps({ briefReady: input.briefReady }),
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
  readonly dataFreshness: InboxDataFreshness;
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
