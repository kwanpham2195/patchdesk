import type { GitHubReadFailure } from "./gh-request-runner";
import type { BranchProtectionRead } from "./github-merge-policy";
import type {
  AuthenticatedGitHubAccount,
  BranchProtectionEvidence,
  FetchedDiffRefs,
  RepositoryPermissionEvidence,
} from "./github-adapter";
import type {
  AssignableUserListing,
  CheckSummary,
  GitHubComments,
  GitHubMergePolicyEvidence,
  GitHubPublishedFeedback,
  MaintainerPullRequestPage,
  MaintainerPullRequestSearchPage,
  MergePolicySnapshot,
  PullRequestCommit,
  PullRequestReviewerListing,
  PullRequestSummary,
  RepositoryLabelListing,
} from "../../domain/github-context";
import type {
  GitHubLogin,
  GitHubReviewNodeId,
  GitHubReviewRestId,
  GitHubThreadId,
  GitSha,
  IsoTimestamp,
  RepoRelativePath,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import type { WatchedSnapshot } from "../../domain/watched-pull-request";
import type {
  InboxPageSize,
  InboxStateFilter,
} from "../../domain/maintainer-inbox";
import type { Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type {
  GitHubReviewEvent,
  PendingReviewAnchor,
  PendingReviewRead,
  PendingReviewThreadWrite,
} from "../../domain/pending-review";
import type { DirectSummaryReviewReceipt } from "../../domain/direct-summary-review";
import type { GitHubWriteFailure } from "../../domain/github-write";
import type { GitHubReviewCoordinates } from "../../domain/patch";

/** The typed read-only operations product code may request from GitHub. */
export interface GitHubReader {
  listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>>;
  listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    /** Trusted service state; the adapter alone maps it to GraphQL OPEN or MERGED. */
    readonly state?: InboxStateFilter;
    /** Requested page size; becomes the GraphQL `first` value. */
    readonly pageSize: InboxPageSize;
    /** Opaque repository continuation from the inbox service, never renderer input. */
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestPage, GitHubReadFailure>>;
  /**
   * Reads one repository-wide `search(type: ISSUE)` page of pull requests,
   * alongside `issueCount` — GitHub's true repository-wide match count for
   * `searchQuery`, distinct from this page's loaded entry count. `state` is
   * required because the search query string alone does not tell the
   * adapter whether the caller is browsing open or merged pull requests, and
   * `parseMaintainerPullRequest` needs it to set `summary.isOpen`.
   */
  searchMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    /** GitHub search qualifier string, e.g. `repo:OWNER/NAME is:pr is:open`. */
    readonly searchQuery: string;
    readonly state: InboxStateFilter;
    /** Requested page size; becomes the GraphQL `first` value. */
    readonly pageSize: InboxPageSize;
    /** Opaque repository continuation from the inbox service, never renderer input. */
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestSearchPage, GitHubReadFailure>>;
  /** Bounded list of labels available in the repository, for populating a label picker. */
  listRepositoryLabels(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<RepositoryLabelListing, GitHubReadFailure>>;
  /** Up to 100 branch names of the repository, alphabetical; `query` filters by name substring. */
  listRepositoryBranches(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly query?: string;
  }): Promise<Result<RepositoryBranchListing, GitHubReadFailure>>;
  /** Bounded list of repository collaborators eligible for assignment, for populating an assignee picker. `query` filters server-side by login/name substring. */
  listAssignableUsers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
    readonly query?: string;
  }): Promise<Result<AssignableUserListing, GitHubReadFailure>>;
  /** One bounded, unpaginated read of a pull request's reviewer state: who is requested, every submitted-or-pending review, and GitHub's own suggestions. See `pullRequestReviewersQuery`. */
  getPullRequestReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestReviewerListing, GitHubReadFailure>>;
  getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>>;
  /** One aliased read of every watched pull request of a profile; refs all share the profile's host. */
  readWatchedPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly refs: ReadonlyArray<PullRequestRef>;
    /** Compared against the host's cached rate-limit reset, so a spent limit skips the call. */
    readonly now: IsoTimestamp;
  }): Promise<Result<ReadonlyArray<WatchedPullRequestRead>, GitHubReadFailure>>;
  getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>>;
  /** Reads bounded, optional branch policy configuration for display-only merge evidence. */
  getMergePolicyEvidence(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
    /** The branch protection read, when the caller already made it; otherwise the adapter reads it. */
    readonly branchProtection?: BranchProtectionRead;
  }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>>;
  getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>>;
  getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>>;
  /** Bounded proof that a thread node belongs to the active pull request; a missing, foreign, or typeless node is a completed read with `found: false`. */
  getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>>;
  /** Bounded proof that a comment node belongs to the active pull request, plus viewer authorship. */
  getReviewCommentTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>>;
  getPullRequestPublishedFeedback?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    /** The branch whose protection decides `canDismiss`, when the caller already read it; otherwise the adapter reads the pull request for it. */
    readonly baseBranch?: string;
    /** The branch protection `canDismiss` derives from, when the caller already read it; otherwise the adapter reads it. */
    readonly branchProtection?: BranchProtectionRead;
  }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>>;
  /** Bounded authenticated repository permission evidence used for record capabilities. */
  getRepositoryPermission?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: string;
  }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>>;
  /** Bounded branch protection evidence; a missing endpoint response means unprotected. */
  getBranchProtection?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>>;
  /** The one branch protection read a cycle can hand to both `getPullRequestPublishedFeedback` and `getMergePolicyEvidence`. */
  readBranchProtection?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<BranchProtectionRead>;
  getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    /** The head this list marks `isHead`, when the caller already read it; otherwise the adapter reads the pull request for it. */
    readonly headSha?: GitSha;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>>;
  getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>>;
  getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    /** Immutable remote comparison used only when no managed checkout exists. */
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>>;
  /** Fetch one bounded text blob at an immutable revision for local diff hydration. */
  getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>>;
  resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>>;
}

/** One watched pull request as GitHub reports it now; `undefined` when GitHub no longer resolves it. */
export type WatchedPullRequestRead = {
  readonly ref: PullRequestRef;
  readonly snapshot: WatchedSnapshot | undefined;
};

/** One bounded page of branch names; compare `totalCount` against `branches.length` to detect truncation. */
export type RepositoryBranchListing = {
  readonly branches: ReadonlyArray<string>;
  readonly totalCount: number;
};

export type MergeOutcome =
  | { readonly state: "open" | "closed_unmerged" }
  | {
      readonly state: "merged";
      readonly mergedAt: IsoTimestamp;
      readonly mergeCommitSha?: GitSha;
    };

/** Whether a thread node is a member of the active pull request. */
export type GitHubThreadTarget =
  | { readonly found: true }
  | { readonly found: false };

/** Whether a comment node is a member of the active pull request, and who authored it. */
export type GitHubCommentTarget =
  | { readonly found: true; readonly viewerDidAuthor: boolean }
  | { readonly found: false };

/** Safe projection for one source file; binary and oversized blobs never enter the renderer. */
export type GitHubFileContents =
  | { readonly state: "available"; readonly contents: string }
  | { readonly state: "binary" | "too_large" };

export type PendingReviewComment = {
  readonly body: string;
  readonly path: string;
  readonly line: number;
  readonly lineEnd?: number;
  readonly diffSide: "new" | "old";
};

/** Explicit write boundary. Product services must recheck the PR head immediately before calling it. */
export interface GitHubReviewWriter {
  createPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<PendingReviewComment>;
  }): Promise<
    Result<
      { readonly reviewId: string; readonly state: "PENDING" },
      GitHubWriteFailure
    >
  >;
  submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>>;
  createInlineComment?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly coordinates: GitHubReviewCoordinates;
    readonly body: string;
  }): Promise<
    Result<
      {
        readonly commentId: string;
        readonly reviewId?: string;
        readonly threadId?: string;
      },
      GitHubWriteFailure
    >
  >;
  createThreadReply?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly body: string;
  }): Promise<
    Result<
      { readonly commentId: string; readonly reviewId?: string },
      GitHubWriteFailure
    >
  >;
  setReviewThreadState?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly state: "resolved" | "open";
  }): Promise<Result<void, GitHubWriteFailure>>;
  /** Applies existing repository labels to a labelable (e.g. a pull request) by GraphQL node ID. */
  addLabelsToLabelable?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>>;
  /** Removes existing labels from a labelable (e.g. a pull request) by GraphQL node ID. */
  removeLabelsFromLabelable?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>>;
  /** Assigns people to an assignable (e.g. a pull request) by GraphQL node ID. */
  addAssigneesToAssignable?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>>;
  /** Unassigns people from an assignable (e.g. a pull request) by GraphQL node ID. */
  removeAssigneesFromAssignable?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>>;
  /** Adds people to a pull request's reviewer set (GraphQL `requestReviews`, `union: true`) without disturbing anyone requested by someone else. */
  requestReviews?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly userIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>>;
  /**
   * Removes named people from a pull request's requested-reviewer set via
   * the subtractive REST endpoint. Deliberately not the GraphQL
   * `requestReviews` mutation resent with the remaining set: that mutation
   * *replaces* the whole reviewer set, so removing one person by resending
   * everyone else would silently drop a request another maintainer added
   * since the last refresh. This DELETE removes only the named logins — see
   * ADR "The conversation rail owns pull request metadata writes".
   */
  removeRequestedReviewers?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly logins: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>>;
  /** Toggles a pull request between draft and ready for review by GraphQL node ID; `draft: false` marks it ready. */
  setPullRequestDraftState?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly draft: boolean;
  }): Promise<Result<void, GitHubWriteFailure>>;
  /** Moves an open pull request onto another branch of its base repository by GraphQL node ID. */
  setPullRequestBaseBranch?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly branch: string;
  }): Promise<Result<void, GitHubWriteFailure>>;
  updateThreadComment?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>>;
  deleteThreadComment?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>>;
  updateReviewComment?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>>;
  deleteReviewComment?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>>;
  dismissReview?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
    readonly message: string;
  }): Promise<Result<void, GitHubWriteFailure>>;
}

export type DirectSummaryPublishedReview = DirectSummaryReviewReceipt & {
  readonly bodyDigest: string;
};

export interface GitHubDirectSummaryGateway {
  getViewerDirectSummaryReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<
    Result<
      {
        readonly reviews: ReadonlyArray<DirectSummaryPublishedReview>;
        readonly complete: boolean;
      },
      GitHubReadFailure
    >
  >;
  createDirectSummaryReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly event: GitHubReviewEvent;
    readonly body: string;
  }): Promise<Result<DirectSummaryReviewReceipt, GitHubWriteFailure>>;
}

export interface GitHubMergeWriter {
  mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>>;
}

/**
 * Spike-proven pending-review operations (2026-08-09). Discard, empty-review,
 * reply, and thread-state behavior are unproven and deliberately absent.
 */
export interface GitHubPendingReviewGateway {
  /**
   * Bounded authenticated read of the viewer's one pending review. Returns
   * None only with a complete result proving no viewer-owned pending review;
   * pagination, missing identity, foreign data, or incomplete comments are
   * Unavailable. The account argument must come from the authenticated-account
   * reader, never from renderer input.
   */
  getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>>;

  /** Create the viewer's pending review with its first inline thread. */
  startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>>;

  /** Append one inline thread to the known pending review. */
  addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>>;

  /**
   * Delete the viewer's pending review (dbacd62-proven REST DELETE contract,
   * normal confirmed response). Timeout or lost response is an unavailable
   * outcome; the caller must never retry automatically.
   */
  discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>>;
}
