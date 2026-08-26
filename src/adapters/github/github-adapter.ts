import * as v from "valibot";

import type {
  CommandFailure,
  CommandRequest,
  CommandRunner,
  ForbiddenReason,
} from "./command-runner";
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "./github-credentials";
import type {
  AssignableUserListing,
  CheckRunSummary,
  CheckSummary,
  Conversation,
  GitHubComment,
  GitHubComments,
  GitHubConversationThread,
  GitHubPublishedFeedback,
  PublishedReviewComment,
  GitHubMergePolicyEvidence,
  PublishedReview,
  PullRequestAssigneePermission,
  PullRequestCommit,
  PullRequestReviewerListing,
  PullRequestSummary,
  MergePolicySnapshot,
  MaintainerPullRequestPage,
  MaintainerPullRequestSearchPage,
  RepositoryLabelListing,
  RepositoryLabelPermission,
} from "../../domain/github-context";
import {
  parseGitSha,
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  type AbsolutePath,
  type GitSha,
  type IsoTimestamp,
  type GitHubLogin,
  type GitHubReviewNodeId,
  type GitHubReviewRestId,
  type GitHubThreadId,
  type RepoRelativePath,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import type { InboxPageSize, InboxScope } from "../../domain/maintainer-inbox";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import {
  type PendingReviewAnchor,
  type PendingReviewRead,
  type PendingReviewThreadWrite,
  type ViewerPendingReview,
} from "../../domain/pending-review";
import type { DirectSummaryReviewReceipt } from "../../domain/direct-summary-review";
import type { GitHubReviewEvent } from "../../domain/pending-review";
import type { GitHubWriteFailure } from "../../domain/github-write";
import type { GitHubReviewCoordinates } from "../../domain/patch";
import {
  addAssigneesToAssignableMutation,
  addLabelsToLabelableMutation,
  assignableUsersQuery,
  confirmCreatedCommentThreadQuery,
  maintainerInboxQuery,
  maintainerInboxSearchQuery,
  maxMergePolicyPages,
  maxPullRequestCommits,
  maxReviewCommentPages,
  maxReviewComments,
  maxReviewThreadPages,
  maxReviewThreads,
  mergePolicyQuery,
  pendingReviewThreadsQuery,
  pullRequestReviewersQuery,
  removeAssigneesFromAssignableMutation,
  removeLabelsFromLabelableMutation,
  repositoryLabelsQuery,
  requestReviewsMutation,
  reviewCommentTargetQuery,
  reviewThreadTargetQuery,
  threadCommentsQuery,
  threadQuery,
} from "./github-graphql-queries";
import {
  addedReviewThreadSchema,
  addedThreadReplySchema,
  assignableUsersResponseSchema,
  branchProtectionSchema,
  checkRunsSchema,
  commitStatusesSchema,
  createdInlineCommentSchema,
  directSummaryReceiptSchema,
  maintainerInboxResponseSchema,
  maintainerInboxSearchResponseSchema,
  mergeOutcomeSchema,
  type MergePolicyPage,
  mergePolicyResponseSchema,
  mergeResultSchema,
  pendingReviewThreadsResponseSchema,
  publishedCommentSchema,
  publishedReviewSchema,
  pullRequestCommitSchema,
  pullRequestReviewersResponseSchema,
  pullRequestSchema,
  repositoryFileSchema,
  repositoryLabelsResponseSchema,
  repositoryPermissionSchema,
  requiredStatusChecksSchema,
  reviewCommentTargetSchema,
  reviewReceiptSchema,
  reviewThreadTargetSchema,
  threadCommentsResponseSchema,
  threadResponseSchema,
  writtenNodeSchema,
} from "./github-wire-schemas";
import {
  completeMergePolicy,
  digestReviewBody,
  directSummaryEvent,
  incompleteMergePolicy,
  isManagedFetchedRef,
  matchesPullRequest,
  overallCheckStatus,
  parseAssignableUser,
  parseComment,
  parseDirectSummaryReceipt,
  parseGitHubTimestamp,
  parseLocation,
  parseMaintainerPullRequest,
  parseMergeOutcome,
  parseMergePolicyPage,
  parseOptionalPolicyResponse,
  parsePendingReview,
  parsePullRequest,
  parsePullRequestReviewerListing,
  parseRepositoryLabel,
  parseRequiredContexts,
  parseReviewId,
  pendingReviewAnchor,
  pendingReviewComment,
  samePendingReviewAnchor,
  toCheckRunSummary,
  toCommitStatusSummary,
  toGitHubReviewComment,
  type CommandFailureClassifier,
} from "./github-wire-projections";
import {
  directSummaryWriteFailure,
  invalid,
  missing,
  writeFailure,
} from "./github-write-failures";

const commandTimeoutMs = 15_000;
// Two source blobs travel through the 2 MiB Electron bridge, so each stays
// below 512 KiB after allowing for JSON framing and multibyte text.
const maxHydratedFileBytes = 512 * 1024;

function graphqlPullRequestState(scope: InboxScope): "OPEN" | "MERGED" {
  return scope === "merged" ? "MERGED" : "OPEN";
}
/** The typed read-only operations product code may request from GitHub. */
export interface GitHubReader {
  listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>>;
  listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    /** Trusted service scope; the adapter alone maps it to GraphQL OPEN or MERGED. */
    readonly scope?: InboxScope;
    /** Requested page size; becomes the GraphQL `first` value. */
    readonly pageSize: InboxPageSize;
    /** Opaque repository continuation from the inbox service, never renderer input. */
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestPage, GitHubReadFailure>>;
  /** Bounded list of labels available in the repository, for populating a label picker. */
  listRepositoryLabels(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<RepositoryLabelListing, GitHubReadFailure>>;
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
  }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>>;
  loadConversation(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<Conversation, GitHubReadFailure>>;
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
  getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
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
    readonly reviewId: string;
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

/** Explicit evidence created by a future fetched-ref owner before Git diff fallback is allowed. */
export type FetchedDiffRefs = {
  readonly repositoryPath: AbsolutePath;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
} & { readonly [fetchedDiffRefsBrand]: "FetchedDiffRefs" };

declare const fetchedDiffRefsBrand: unique symbol;

/** Safe parser for the managed refs that permit the adapter's Git diff fallback. */
export function createFetchedDiffRefs(input: {
  readonly repositoryPath: AbsolutePath;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
}): Result<FetchedDiffRefs, InvalidFetchedDiffRefs> {
  if (
    !isManagedFetchedRef(input.baseRef) ||
    !isManagedFetchedRef(input.headRef)
  ) {
    return err({ _tag: "InvalidFetchedDiffRefs" });
  }

  // SAFETY: the parser above establishes that both ref arguments name Patchdesk-managed refs,
  // and the branded path and expected commit IDs have already passed their boundary parsers.
  return ok(input as FetchedDiffRefs);
}

/** Expected failure for invalid fetched-ref fallback evidence. */
export type InvalidFetchedDiffRefs = {
  readonly _tag: "InvalidFetchedDiffRefs";
};

/** Safe identity projection from a successful local gh auth-status check. */
export type AuthenticatedGitHubAccount = {
  readonly host: string;
  readonly account: string;
};

/**
 * GitHub's granular repository-role vocabulary, as reported by the
 * collaborator-permission endpoint's `role_name` field.
 */
const KNOWN_REPOSITORY_ROLES = [
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
] as const;
type KnownRepositoryRole = (typeof KNOWN_REPOSITORY_ROLES)[number];
const KNOWN_REPOSITORY_ROLE_SET: ReadonlySet<string> = new Set(
  KNOWN_REPOSITORY_ROLES,
);
function isKnownRepositoryRole(value: string): value is KnownRepositoryRole {
  return KNOWN_REPOSITORY_ROLE_SET.has(value);
}

export type RepositoryPermissionEvidence = {
  readonly account: string;
  readonly permission: KnownRepositoryRole | "unknown";
  readonly pullRequestsWrite: boolean;
  /**
   * `triage` can apply/dismiss existing labels despite lacking pull-request
   * write access, so this is derived separately from `pullRequestsWrite`
   * rather than reusing it.
   */
  readonly canManageLabels: boolean;
};

/**
 * Projects optional repository-permission evidence into a three-state label
 * capability. Missing or failed evidence yields `unknown`, never a wrong
 * extreme in either direction — see `RepositoryLabelPermission`.
 */
export function repositoryLabelPermission(
  permission:
    | Result<RepositoryPermissionEvidence, GitHubReadFailure>
    | undefined,
): RepositoryLabelPermission {
  if (permission === undefined || permission._tag === "err") return "unknown";
  return permission.value.canManageLabels ? "permitted" : "denied";
}

/**
 * Projects optional repository-permission evidence into a three-state
 * pull-request-write capability. Derived from `pullRequestsWrite`, not
 * `canManageLabels` — per ADR "The conversation rail owns pull request
 * metadata writes", assigning and requesting/removing reviewers both need
 * pull-request write, unlike labeling which `triage` can also do. Missing
 * or failed evidence yields `unknown`, never a wrong extreme in either
 * direction — see `PullRequestAssigneePermission`, whose name predates this
 * function covering reviewers too (kept as-is: renderer components outside
 * this change's scope import that type name directly). Renamed from
 * `pullRequestAssigneePermission` to `pullRequestWritePermission` because
 * `AssigneeService` and `ReviewerService` both resolve their write
 * permission through this one function now, not just assignees.
 */
export function pullRequestWritePermission(
  permission:
    | Result<RepositoryPermissionEvidence, GitHubReadFailure>
    | undefined,
): PullRequestAssigneePermission {
  if (permission === undefined || permission._tag === "err") return "unknown";
  return permission.value.pullRequestsWrite ? "permitted" : "denied";
}

export type BranchProtectionEvidence = {
  readonly protected: boolean;
  readonly allowedDismissers: ReadonlyArray<string>;
};

/** Safe expected failures emitted by the GitHub read boundary. */
export type GitHubReadFailure =
  | {
      readonly _tag: "GitHubAuthenticationFailed";
      readonly operation: GitHubReadOperation;
    }
  | {
      readonly _tag: "GitHubReadFailed";
      readonly operation: GitHubReadOperation;
    }
  | {
      readonly _tag: "GitHubResponseInvalid";
      readonly operation: GitHubReadOperation;
    }
  | {
      readonly _tag: "GitHubRateLimited";
      readonly operation: GitHubReadOperation;
      readonly resumeAt?: IsoTimestamp;
    }
  | {
      readonly _tag: "GitHubForbidden";
      readonly operation: GitHubReadOperation;
      readonly reason: ForbiddenReason;
    };

export type GitHubReadOperation =
  | "list_open_prs"
  | "list_maintainer_prs"
  | "search_maintainer_prs"
  | "list_repository_labels"
  | "list_assignable_users"
  | "get_pull_request_reviewers"
  | "get_pr"
  | "get_merge_policy"
  | "get_merge_policy_evidence"
  | "get_comments"
  | "get_reviews"
  | "get_pending_review"
  | "get_direct_summary_reviews"
  | "load_conversation"
  | "get_repository_permission"
  | "get_branch_protection"
  | "get_pr_commits"
  | "get_checks"
  | "get_diff"
  | "get_file"
  | "compare_revisions"
  | "get_thread_target"
  | "get_comment_target"
  | "auth_status";

/** A gh invocation whose account environment the adapter supplies from the profile. */
type GhCommandRequest = Omit<
  CommandRequest,
  "environment" | "inheritEnvironment"
>;

/**
 * GitHub CLI external adapter. It owns all gh execution and returns parsed, safe projections.
 * Read operations and explicit review writes live in the main process; renderer code never reaches this adapter.
 */
export class GitHubAdapter
  implements GitHubReader, GitHubReviewWriter, GitHubMergeWriter
{
  /**
   * Last-observed rateLimit { remaining, resetAt } per GitHub host, learned
   * opportunistically from the maintainerInboxQuery response on every
   * successful poll. Consulted when classifying a later CommandRateLimited
   * failure on the same host so the resume time can be surfaced proactively.
   */
  private readonly rateLimitByHost = new Map<
    string,
    { readonly remaining: number; readonly resetAt: IsoTimestamp }
  >();

  constructor(
    private readonly commands: CommandRunner,
    private readonly credentials: GitHubCredentials = new GitHubCliCredentials(
      commands,
    ),
  ) {}

  /** Run a gh command that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.runAsProfileAccount(profile, request, (input) =>
      this.commands.runJson(input),
    );
  }

  /** Run a gh command that returns text as the profile's configured GitHub account. */
  private async ghText(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<string, CommandFailure>> {
    return this.runAsProfileAccount(profile, request, (input) =>
      this.commands.runText(input),
    );
  }

  private async runAsProfileAccount<T>(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
    run: (input: CommandRequest) => Promise<Result<T, CommandFailure>>,
  ): Promise<Result<T, CommandFailure>> {
    const environment = await this.credentials.environmentFor(profile);
    if (environment._tag === "err") return environment;
    const response = await run({ ...request, environment: environment.value });
    if (
      response._tag === "err" &&
      response.error._tag === "CommandAuthenticationRequired"
    ) {
      this.credentials.forget(profile);
    }
    return response;
  }

  /**
   * Classify a failed CommandFailure into a GitHubReadFailure. A rate-limited
   * failure carries the last-observed resetAt for `host` when one is cached
   * (see rateLimitByHost); when the cache is cold, resumeAt is left undefined
   * and a fallback delay is applied at the point that schedules the wait,
   * not baked in here.
   */
  private commandFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<never, GitHubReadFailure> {
    if (failure._tag === "CommandAuthenticationRequired")
      return err({ _tag: "GitHubAuthenticationFailed", operation });
    if (failure._tag === "CommandRateLimited") {
      const cached = this.rateLimitByHost.get(host);
      const resumeAtField =
        cached === undefined ? {} : { resumeAt: cached.resetAt };
      return err({ _tag: "GitHubRateLimited", operation, ...resumeAtField });
    }
    if (failure._tag === "CommandForbidden") {
      return err({
        _tag: "GitHubForbidden",
        operation,
        reason: failure.reason,
      });
    }
    return err({ _tag: "GitHubReadFailed", operation });
  }

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.repo.owner}/${input.repo.repo}/pulls?state=open&per_page=100`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "list_open_prs",
        response.error,
        input.profile.githubHost,
      );
    if (!Array.isArray(response.value)) return invalid("list_open_prs");

    const summaries: Array<PullRequestSummary> = [];
    for (const value of response.value) {
      const raw = v.safeParse(pullRequestSchema, value);
      if (!raw.success) return invalid("list_open_prs");
      const summary = parsePullRequest(
        raw.output,
        input.profile.githubHost,
        input.repo.owner,
        input.repo.repo,
      );
      if (summary._tag === "err") return invalid("list_open_prs");
      summaries.push(summary.value);
    }
    return ok(summaries);
  }

  /** Reads exactly one trusted-scope page of pull requests with edge cursors. */
  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly scope?: InboxScope;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestPage, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        `query=${maintainerInboxQuery}`,
        "-F",
        `owner=${input.repo.owner}`,
        "-F",
        `name=${input.repo.repo}`,
        "-F",
        `first=${input.pageSize}`,
        "-F",
        `state=${graphqlPullRequestState(input.scope ?? "open")}`,
        ...(input.cursor === undefined ? [] : ["-f", `cursor=${input.cursor}`]),
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure("list_maintainer_prs", response.error, host);
    const parsed = v.safeParse(maintainerInboxResponseSchema, response.value);
    if (!parsed.success) return invalid("list_maintainer_prs");
    const rateLimit = parsed.output.data.rateLimit;
    if (rateLimit !== undefined) {
      const resumeAt = parseGitHubTimestamp(rateLimit.resetAt);
      if (resumeAt._tag === "ok")
        this.rateLimitByHost.set(host, {
          remaining: rateLimit.remaining,
          resetAt: resumeAt.value,
        });
    }
    const connection = parsed.output.data.repository.pullRequests;
    if (
      connection.pageInfo.hasNextPage &&
      (connection.pageInfo.endCursor === null ||
        connection.pageInfo.endCursor === undefined)
    )
      return invalid("list_maintainer_prs");
    const entries = [];
    for (const edge of connection.edges) {
      const projected = parseMaintainerPullRequest(
        edge.node,
        host,
        input.repo.owner,
        input.repo.repo,
        input.scope ?? "open",
      );
      if (projected._tag === "err") return invalid("list_maintainer_prs");
      entries.push({ cursor: edge.cursor, pullRequest: projected.value });
    }
    const endCursorField =
      connection.pageInfo.endCursor === null ||
      connection.pageInfo.endCursor === undefined
        ? {}
        : { endCursor: connection.pageInfo.endCursor };
    return ok({
      entries,
      hasNextPage: connection.pageInfo.hasNextPage,
      ...endCursorField,
    });
  }

  /**
   * Reads one repository-wide `search(type: ISSUE)` page of pull requests
   * with edge cursors, alongside `issueCount` — GitHub's true repository-wide
   * match count for `searchQuery`, distinct from this page's loaded entry
   * count. Mirrors `listMaintainerPullRequests`'s structure; unlike that
   * method, `scope` is required here because the search query string alone
   * does not tell the adapter whether the caller is browsing open or merged
   * pull requests, and `parseMaintainerPullRequest` needs it to set
   * `summary.isOpen`.
   */
  async searchMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly searchQuery: string;
    readonly scope: InboxScope;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestSearchPage, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        `query=${maintainerInboxSearchQuery}`,
        "-F",
        `search=${input.searchQuery}`,
        "-F",
        `first=${input.pageSize}`,
        ...(input.cursor === undefined ? [] : ["-f", `cursor=${input.cursor}`]),
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure("search_maintainer_prs", response.error, host);
    const parsed = v.safeParse(
      maintainerInboxSearchResponseSchema,
      response.value,
    );
    if (!parsed.success) return invalid("search_maintainer_prs");
    const rateLimit = parsed.output.data.rateLimit;
    if (rateLimit !== undefined) {
      const resumeAt = parseGitHubTimestamp(rateLimit.resetAt);
      if (resumeAt._tag === "ok")
        this.rateLimitByHost.set(host, {
          remaining: rateLimit.remaining,
          resetAt: resumeAt.value,
        });
    }
    const connection = parsed.output.data.search;
    if (
      connection.pageInfo.hasNextPage &&
      (connection.pageInfo.endCursor === null ||
        connection.pageInfo.endCursor === undefined)
    )
      return invalid("search_maintainer_prs");
    const entries = [];
    for (const edge of connection.edges) {
      const projected = parseMaintainerPullRequest(
        edge.node,
        host,
        input.repo.owner,
        input.repo.repo,
        input.scope,
      );
      if (projected._tag === "err") return invalid("search_maintainer_prs");
      entries.push({ cursor: edge.cursor, pullRequest: projected.value });
    }
    const endCursorField =
      connection.pageInfo.endCursor === null ||
      connection.pageInfo.endCursor === undefined
        ? {}
        : { endCursor: connection.pageInfo.endCursor };
    return ok({
      entries,
      hasNextPage: connection.pageInfo.hasNextPage,
      issueCount: connection.issueCount,
      ...endCursorField,
    });
  }

  /** Fetches up to 100 repository labels in one bounded page; `totalCount` reveals truncation beyond that. */
  async listRepositoryLabels(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<RepositoryLabelListing, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        `query=${repositoryLabelsQuery}`,
        "-F",
        `owner=${input.repo.owner}`,
        "-F",
        `name=${input.repo.repo}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "list_repository_labels",
        response.error,
        host,
      );
    const parsed = v.safeParse(repositoryLabelsResponseSchema, response.value);
    if (!parsed.success) return invalid("list_repository_labels");
    const connection = parsed.output.data.repository.labels;
    return ok({
      labels: connection.nodes.map(parseRepositoryLabel),
      totalCount: connection.totalCount,
    });
  }

  /** Fetches up to 100 repository collaborators eligible for assignment in one bounded page; `totalCount` reveals truncation beyond that. `query` filters server-side by login/name substring when provided. */
  async listAssignableUsers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
    readonly query?: string;
  }): Promise<Result<AssignableUserListing, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        `query=${assignableUsersQuery}`,
        "-F",
        `owner=${input.repo.owner}`,
        "-F",
        `name=${input.repo.repo}`,
        ...(input.query !== undefined && input.query.length > 0
          ? ["-F", `search=${input.query}`]
          : []),
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure("list_assignable_users", response.error, host);
    const parsed = v.safeParse(assignableUsersResponseSchema, response.value);
    if (!parsed.success) return invalid("list_assignable_users");
    const connection = parsed.output.data.repository.assignableUsers;
    return ok({
      users: connection.nodes.map(parseAssignableUser),
      totalCount: connection.totalCount,
    });
  }

  async getPullRequestReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestReviewerListing, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        `query=${pullRequestReviewersQuery}`,
        "-F",
        `owner=${input.pr.owner}`,
        "-F",
        `name=${input.pr.repo}`,
        "-F",
        `number=${input.pr.number}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_pull_request_reviewers",
        response.error,
        host,
      );
    const parsed = v.safeParse(
      pullRequestReviewersResponseSchema,
      response.value,
    );
    if (!parsed.success) return invalid("get_pull_request_reviewers");
    return ok(
      parsePullRequestReviewerListing(
        parsed.output.data.repository.pullRequest,
      ),
    );
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") {
      return this.commandFailure(
        "get_pr",
        response.error,
        input.profile.githubHost,
      );
    }
    const raw = v.safeParse(pullRequestSchema, response.value);
    if (!raw.success) return invalid("get_pr");
    const parsed = parsePullRequest(
      raw.output,
      input.profile.githubHost,
      input.pr.owner,
      input.pr.repo,
    );
    return parsed._tag === "ok" ? parsed : invalid("get_pr");
  }

  async getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>> {
    const contexts: Array<CheckRunSummary> = [];
    let cursor: string | undefined;
    let policyPage: MergePolicyPage | undefined;
    for (let page = 0; page < maxMergePolicyPages; page += 1) {
      const response = await this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "graphql",
          "--hostname",
          input.profile.githubHost,
          "-f",
          `query=${mergePolicyQuery}`,
          "-F",
          `owner=${input.pr.owner}`,
          "-F",
          `name=${input.pr.repo}`,
          "-F",
          `number=${input.pr.number}`,
          ...(cursor === undefined ? [] : ["-F", `cursor=${cursor}`]),
        ],
        timeoutMs: commandTimeoutMs,
      });
      if (response._tag === "err")
        return this.commandFailure(
          "get_merge_policy",
          response.error,
          input.profile.githubHost,
        );
      const raw = v.safeParse(mergePolicyResponseSchema, response.value);
      if (!raw.success) return invalid("get_merge_policy");
      const parsed = parseMergePolicyPage(raw.output);
      if (parsed === undefined) return invalid("get_merge_policy");
      if (
        policyPage !== undefined &&
        (parsed.headSha !== policyPage.headSha ||
          parsed.baseSha !== policyPage.baseSha)
      )
        return ok(incompleteMergePolicy(input.pr, parsed, contexts, "mapping"));
      policyPage = parsed;
      contexts.push(...parsed.contexts);
      if (!parsed.hasNextPage) break;
      cursor = parsed.endCursor;
      if (cursor === undefined)
        return ok(
          incompleteMergePolicy(input.pr, parsed, contexts, "pagination"),
        );
    }
    if (policyPage === undefined) return invalid("get_merge_policy");
    if (policyPage.hasNextPage)
      return ok(
        incompleteMergePolicy(input.pr, policyPage, contexts, "pagination"),
      );
    if (policyPage.headSha !== input.expectedHeadSha)
      return ok(
        incompleteMergePolicy(input.pr, policyPage, contexts, "head_mismatch"),
      );

    const required = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(policyPage.baseBranch)}/protection/required_status_checks`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    // GitHub returns 404 when the branch has no classic required-status-check
    // policy. Rulesets remain available through the GraphQL policy read above.
    // All other failures stay fail-closed because the required checks are unknown.
    if (required._tag === "err") {
      if (required.error._tag === "CommandNotFound")
        return ok(
          completeMergePolicy(input.pr, policyPage, contexts, new Set()),
        );
      return ok(
        incompleteMergePolicy(input.pr, policyPage, contexts, "permission"),
      );
    }
    const rawRequired = v.safeParse(requiredStatusChecksSchema, required.value);
    if (!rawRequired.success)
      return ok(
        incompleteMergePolicy(input.pr, policyPage, contexts, "mapping"),
      );
    const requiredContexts = parseRequiredContexts(rawRequired.output);
    return ok(
      completeMergePolicy(input.pr, policyPage, contexts, requiredContexts),
    );
  }

  async getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_pr",
        response.error,
        input.profile.githubHost,
      );
    const raw = v.safeParse(mergeOutcomeSchema, response.value);
    return raw.success ? parseMergeOutcome(raw.output) : invalid("get_pr");
  }

  async getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>> {
    const current = await this.getPullRequest(input);
    if (current._tag === "err") return current;
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--paginate",
        "--slurp",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/commits?per_page=100`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_pr_commits",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(
      v.array(v.array(pullRequestCommitSchema)),
      response.value,
    );
    if (!parsed.success) return invalid("get_pr_commits");
    const rawCommits = parsed.output.flat();
    // GitHub caps this endpoint at 250 entries; without continuation metadata,
    // accepting exactly 250 could persist a truncated list as complete.
    if (rawCommits.length === 0 || rawCommits.length >= maxPullRequestCommits)
      return invalid("get_pr_commits");
    const commits: PullRequestCommit[] = [];
    for (const raw of rawCommits) {
      const sha = parseGitSha(raw.sha);
      const authoredAt =
        raw.commit.author === null
          ? err({ _tag: "Invalid" as const })
          : parseGitHubTimestamp(raw.commit.author.date);
      if (sha._tag === "err" || authoredAt._tag === "err")
        return invalid("get_pr_commits");
      const commit = {
        sha: sha.value,
        message: raw.commit.message,
        author: raw.commit.author?.name ?? "ghost",
        authoredAt: authoredAt.value,
        isHead: sha.value === current.value.headSha,
      };
      commits.push(
        raw.html_url === undefined ? commit : { ...commit, url: raw.html_url },
      );
    }
    commits.sort((left, right) =>
      right.authoredAt.localeCompare(left.authoredAt),
    );
    return ok(commits);
  }

  async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    const threads: Array<GitHubConversationThread> = [];
    let totalComments = 0;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (
      let page = 0;
      page < maxReviewThreadPages && threads.length < maxReviewThreads;
      page += 1
    ) {
      const response = await this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "graphql",
          "--hostname",
          input.profile.githubHost,
          "-f",
          `query=${threadQuery}`,
          "-F",
          `owner=${input.pr.owner}`,
          "-F",
          `name=${input.pr.repo}`,
          "-F",
          `number=${input.pr.number}`,
          ...(cursor === undefined ? [] : ["-F", `cursor=${cursor}`]),
        ],
        timeoutMs: commandTimeoutMs,
      });
      if (response._tag === "err") {
        return this.commandFailure(
          "get_comments",
          response.error,
          input.profile.githubHost,
        );
      }
      const parsed = v.safeParse(threadResponseSchema, response.value);
      if (!parsed.success) return invalid("get_comments");

      for (const rawThread of parsed.output.data.repository.pullRequest
        .reviewThreads.nodes) {
        const comments: Array<GitHubComment> = [];
        for (const rawComment of rawThread.comments.nodes) {
          if (totalComments >= maxReviewComments) {
            return ok({
              threads,
              complete: false,
              incompleteReason: "comment_cap",
            });
          }
          const comment = parseComment(rawComment);
          if (comment._tag === "err") return invalid("get_comments");
          comments.push(comment.value);
          totalComments += 1;
        }
        const replyPage = rawThread.comments.pageInfo;
        const replies =
          replyPage !== undefined && replyPage.hasNextPage
            ? await this.loadThreadReplies(
                input.profile,
                rawThread.id,
                comments,
                replyPage.endCursor ?? null,
                maxReviewComments - totalComments,
              )
            : { comments, complete: true };
        totalComments += replies.comments.length - comments.length;
        const threadId = parseGitHubThreadId(rawThread.id);
        if (threadId._tag === "err") return invalid("get_comments");
        const location = parseLocation(
          rawThread.path,
          rawThread.line,
          rawThread.originalLine,
          rawThread.startLine,
          rawThread.diffSide,
          rawThread.startDiffSide,
        );
        if (location !== undefined && comments[0] !== undefined) {
          comments[0] = { ...comments[0], location };
        }
        const thread: GitHubConversationThread = {
          id: threadId.value,
          state: rawThread.isResolved
            ? "resolved"
            : rawThread.isOutdated
              ? "outdated"
              : ("open" as const),
          comments: replies.comments,
          complete: replies.complete,
        };
        threads.push(location === undefined ? thread : { ...thread, location });
      }
      const pageInfo =
        parsed.output.data.repository.pullRequest.reviewThreads.pageInfo;
      if (pageInfo === undefined)
        return ok({ threads, complete: false, incompleteReason: "pagination" });
      if (!pageInfo.hasNextPage) {
        const complete = threads.every((thread) => thread.complete !== false);
        return complete
          ? ok({ threads, complete })
          : ok({ threads, complete, incompleteReason: "comment_cap" as const });
      }
      const nextCursor = pageInfo.endCursor;
      if (nextCursor === null || nextCursor === undefined)
        return ok({ threads, complete: false, incompleteReason: "pagination" });
      if (threads.length >= maxReviewThreads)
        return ok({ threads, complete: false, incompleteReason: "thread_cap" });
      if (cursors.has(nextCursor))
        return ok({ threads, complete: false, incompleteReason: "pagination" });
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    return ok({ threads, complete: false, incompleteReason: "thread_cap" });
  }

  async getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${reviewThreadTargetQuery}`,
        "-F",
        `id=${input.threadId}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return missing("get_thread_target");
    const parsed = v.safeParse(reviewThreadTargetSchema, response.value);
    // A missing node, an unexpected node type, or a thread with no first
    // comment is a completed read whose target is simply not a member.
    if (!parsed.success) return ok({ found: false });
    const node = parsed.output.data.node;
    const comment = node?.comments.nodes[0];
    if (node?.id !== input.threadId || comment === undefined)
      return ok({ found: false });
    return matchesPullRequest(comment.pullRequest, input.pr)
      ? ok({ found: true })
      : ok({ found: false });
  }

  async getReviewCommentTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${reviewCommentTargetQuery}`,
        "-F",
        `id=${input.commentId}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return missing("get_comment_target");
    const parsed = v.safeParse(reviewCommentTargetSchema, response.value);
    if (!parsed.success) return ok({ found: false });
    const node = parsed.output.data.node;
    if (node === null || node === undefined || node.id !== input.commentId)
      return ok({ found: false });
    return matchesPullRequest(node.pullRequest, input.pr)
      ? ok({ found: true, viewerDidAuthor: node.viewerDidAuthor })
      : ok({ found: false });
  }

  async getPullRequestPublishedFeedback(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>> {
    const [reviews, comments, account] = await Promise.all([
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews?per_page=100&page=1`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/comments?per_page=100&page=1`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
      this.resolveAuthenticatedAccount(input.profile),
    ]);
    if (reviews._tag === "err")
      return this.commandFailure(
        "get_reviews",
        reviews.error,
        input.profile.githubHost,
      );
    if (comments._tag === "err")
      return this.commandFailure(
        "get_comments",
        comments.error,
        input.profile.githubHost,
      );
    const permission =
      account._tag === "ok" && account.value.account === input.profile.ghAccount
        ? await this.getRepositoryPermission({
            profile: input.profile,
            pr: input.pr,
            account: account.value.account,
          })
        : undefined;
    const pullRequest = await this.getPullRequest({
      profile: input.profile,
      pr: input.pr,
    });
    const protection =
      permission?._tag === "ok" && pullRequest._tag === "ok"
        ? await this.getBranchProtection({
            profile: input.profile,
            pr: input.pr,
            branch: pullRequest.value.baseBranch,
          })
        : undefined;
    const canWrite =
      permission?._tag === "ok" &&
      permission.value.account === input.profile.ghAccount &&
      permission.value.pullRequestsWrite;
    const isAdmin =
      permission?._tag === "ok" && permission.value.permission === "admin";
    const canDismiss =
      canWrite === true &&
      (isAdmin === true ||
        (protection?._tag === "ok" &&
          (protection.value.protected === false ||
            protection.value.allowedDismissers.includes(
              input.profile.ghAccount,
            ))));
    const parsedReviews = v.safeParse(publishedReviewSchema, reviews.value);
    const parsedComments = v.safeParse(publishedCommentSchema, comments.value);
    if (!parsedReviews.success || !parsedComments.success)
      return invalid("get_reviews");
    const publishedReviews: PublishedReview[] = [];
    for (const review of parsedReviews.output) {
      // PENDING reviews are started but not submitted; they carry no
      // submitted_at and are not published feedback.
      if (review.submitted_at === undefined || review.submitted_at === null)
        continue;
      const submittedAt = parseGitHubTimestamp(review.submitted_at);
      if (submittedAt._tag === "err") return invalid("get_reviews");
      const event = review.state.toUpperCase();
      if (
        event !== "APPROVED" &&
        event !== "COMMENTED" &&
        event !== "CHANGES_REQUESTED" &&
        event !== "DISMISSED"
      )
        continue;
      const published: PublishedReview = {
        id: String(review.id),
        author: review.user?.login ?? "ghost",
        body: review.body ?? "",
        event,
        submittedAt: submittedAt.value,
        canDismiss: canDismiss && event !== "DISMISSED",
      };
      publishedReviews.push(
        review.node_id === undefined
          ? published
          : { ...published, nodeId: review.node_id },
      );
    }
    const publishedComments: PublishedReviewComment[] = [];
    for (const comment of parsedComments.output) {
      const createdAt = parseGitHubTimestamp(comment.created_at);
      const updatedAt =
        comment.updated_at === undefined || comment.updated_at === null
          ? undefined
          : parseGitHubTimestamp(comment.updated_at);
      if (
        createdAt._tag === "err" ||
        (updatedAt !== undefined && updatedAt._tag === "err")
      )
        return invalid("get_comments");
      const location = parseLocation(
        comment.path,
        comment.line,
        undefined,
        comment.start_line,
        comment.side,
        undefined,
      );
      const author = comment.user?.login ?? "ghost";
      const authorAvatarUrl = comment.user?.avatar_url ?? undefined;
      const owned =
        account._tag === "ok" &&
        account.value.account === input.profile.ghAccount &&
        author === account.value.account;
      let published: PublishedReviewComment = {
        id: String(comment.id),
        author,
        body: comment.body,
        createdAt: createdAt.value,
        canEdit: owned && canWrite === true,
        canDelete: owned && canWrite === true,
      };
      if (authorAvatarUrl !== undefined)
        published = { ...published, authorAvatarUrl };
      if (comment.node_id !== undefined)
        published = { ...published, nodeId: comment.node_id };
      if (updatedAt !== undefined)
        published = { ...published, updatedAt: updatedAt.value };
      if (comment.html_url !== undefined)
        published = { ...published, url: comment.html_url };
      if (location !== undefined) published = { ...published, location };
      if (
        comment.pull_request_review_id !== undefined &&
        comment.pull_request_review_id !== null
      )
        published = {
          ...published,
          reviewId: String(comment.pull_request_review_id),
        };
      publishedComments.push(published);
    }
    const complete =
      parsedReviews.output.length < 100 && parsedComments.output.length < 100;
    const feedback = {
      reviews: publishedReviews,
      comments: publishedComments,
      complete,
    };
    return ok(
      complete
        ? feedback
        : { ...feedback, incompleteReason: "pagination" as const },
    );
  }

  async getRepositoryPermission(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: string;
  }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/collaborators/${encodeURIComponent(input.account)}/permission`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_repository_permission",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(repositoryPermissionSchema, response.value);
    if (!parsed.success) return invalid("get_repository_permission");
    const roleName = parsed.output.role_name;
    // A GitHub custom repository role reports a role_name this codebase has
    // never seen. Degrade it to an explicit "unknown" state with every
    // derived capability denied, rather than failing the whole read closed —
    // see ADR "Choose a validation style by data boundary" (0022).
    const permission = isKnownRepositoryRole(roleName) ? roleName : "unknown";
    return ok({
      account: input.account,
      permission,
      pullRequestsWrite:
        permission === "admin" ||
        permission === "maintain" ||
        permission === "write",
      // Apply/dismiss-labels is granted to triage and above, not just the
      // pull-request-write roles: https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization
      canManageLabels:
        permission === "admin" ||
        permission === "maintain" ||
        permission === "write" ||
        permission === "triage",
    });
  }

  async getBranchProtection(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(input.branch)}/protection`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    // GitHub returns 404 for an unprotected branch (rather than an empty policy).
    // Treat that absence as affirmative unprotected evidence; other failures remain
    // fail-closed so malformed or unavailable permission evidence cannot grant writes.
    if (response._tag === "err" && response.error._tag === "CommandNotFound") {
      return ok({ protected: false, allowedDismissers: [] });
    }
    if (response._tag === "err")
      return this.commandFailure(
        "get_branch_protection",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(branchProtectionSchema, response.value);
    if (!parsed.success) return invalid("get_branch_protection");
    const rules = parsed.output.required_pull_request_reviews;
    const restrictions = rules?.dismissal_restrictions;
    return ok({
      protected: rules !== undefined && rules !== null,
      allowedDismissers: restrictions?.users?.map((user) => user.login) ?? [],
    });
  }

  async getMergePolicyEvidence(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>> {
    const [branchProtection, appliedRuleset] = await Promise.all([
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(input.branch)}/protection`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/rules/branches/${encodeURIComponent(input.branch)}`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
    ]);
    const classify: CommandFailureClassifier = (operation, failure) =>
      this.commandFailure(operation, failure, input.profile.githubHost);
    const branch = parseOptionalPolicyResponse(
      branchProtection,
      "branchProtection",
      classify,
    );
    if (branch._tag === "err") return branch;
    const rules = parseOptionalPolicyResponse(
      appliedRuleset,
      "appliedRuleset",
      classify,
    );
    if (rules._tag === "err") return rules;
    return ok({ branchProtection: branch.value, appliedRuleset: rules.value });
  }

  private async loadThreadReplies(
    profile: WorkspaceProfileConfig,
    threadId: string,
    initial: ReadonlyArray<GitHubComment>,
    initialCursor: string | null,
    remainingComments: number,
  ): Promise<{
    readonly comments: ReadonlyArray<GitHubComment>;
    readonly complete: boolean;
  }> {
    const comments = [...initial];
    let cursor = initialCursor;
    for (
      let page = 0;
      page < maxReviewCommentPages &&
      comments.length - initial.length < remainingComments;
      page += 1
    ) {
      if (cursor === null) return { comments, complete: false };
      const response = await this.ghJson(profile, {
        argv: [
          "gh",
          "api",
          "graphql",
          "--hostname",
          profile.githubHost,
          "-f",
          `query=${threadCommentsQuery}`,
          "-F",
          `id=${threadId}`,
          "-F",
          `cursor=${cursor}`,
        ],
        timeoutMs: commandTimeoutMs,
      });
      if (response._tag === "err") return { comments, complete: false };
      const parsed = v.safeParse(threadCommentsResponseSchema, response.value);
      if (!parsed.success) return { comments, complete: false };
      for (const rawComment of parsed.output.data.node.comments.nodes) {
        const comment = parseComment(rawComment);
        if (comment._tag === "err") return { comments, complete: false };
        comments.push(comment.value);
      }
      const pageInfo = parsed.output.data.node.comments.pageInfo;
      if (!pageInfo.hasNextPage) return { comments, complete: true };
      cursor = pageInfo.endCursor ?? null;
    }
    return { comments, complete: false };
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    const [checkRunsResponse, statusesResponse] = await Promise.all([
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/commits/${input.headSha}/check-runs`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/commits/${input.headSha}/status`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
    ]);
    if (checkRunsResponse._tag === "err" && statusesResponse._tag === "err")
      return this.commandFailure(
        "get_checks",
        checkRunsResponse.error,
        input.profile.githubHost,
      );
    const checks =
      checkRunsResponse._tag === "ok"
        ? v.safeParse(checkRunsSchema, checkRunsResponse.value)
        : undefined;
    const statuses =
      statusesResponse._tag === "ok"
        ? v.safeParse(commitStatusesSchema, statusesResponse.value)
        : undefined;
    if (checks?.success !== true && statuses?.success !== true)
      return invalid("get_checks");

    const summaries = [
      ...(checks?.success === true
        ? checks.output.check_runs.map(toCheckRunSummary)
        : []),
      ...(statuses?.success === true
        ? statuses.output.statuses.map(toCommitStatusSummary)
        : []),
    ];
    return ok({ overall: overallCheckStatus(summaries), checks: summaries });
  }

  async getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    /** Immutable remote comparison used only when no managed checkout exists. */
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>> {
    if (input.fetchedRefs !== undefined) {
      const fetchedRefs = await this.verifyFetchedRefs(input.fetchedRefs);
      if (fetchedRefs._tag === "err") return fetchedRefs;

      const exact = await this.commands.runText({
        argv: [
          "git",
          "-C",
          input.fetchedRefs.repositoryPath,
          "diff",
          "--no-ext-diff",
          `${input.fetchedRefs.baseRef}...${input.fetchedRefs.headRef}`,
        ],
        timeoutMs: commandTimeoutMs,
      });
      return exact._tag === "ok"
        ? exact
        : this.commandFailure(
            "get_diff",
            exact.error,
            input.profile.githubHost,
          );
    }

    if (input.snapshot !== undefined) {
      const exact = await this.ghText(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          "-H",
          "Accept: application/vnd.github.v3.diff",
          `repos/${input.pr.owner}/${input.pr.repo}/compare/${input.snapshot.baseSha}...${input.snapshot.headSha}`,
        ],
        timeoutMs: commandTimeoutMs,
      });
      return exact._tag === "ok"
        ? exact
        : this.commandFailure(
            "get_diff",
            exact.error,
            input.profile.githubHost,
          );
    }

    const response = await this.ghText(input.profile, {
      argv: [
        "gh",
        "pr",
        "diff",
        String(input.pr.number),
        "--repo",
        `${input.profile.githubHost}/${input.pr.owner}/${input.pr.repo}`,
        "--patch",
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "ok" && response.value.length > 0) return response;
    if (
      response._tag === "err" &&
      response.error._tag === "CommandAuthenticationRequired"
    ) {
      return this.commandFailure(
        "get_diff",
        response.error,
        input.profile.githubHost,
      );
    }
    return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
  }

  async getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>> {
    const encodedPath = input.path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/contents/${encodedPath}?ref=${input.sha}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_file",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(repositoryFileSchema, response.value);
    if (!parsed.success || parsed.output.type !== "file")
      return invalid("get_file");
    if ((parsed.output.size ?? 0) > maxHydratedFileBytes) {
      return ok({ state: "too_large" });
    }
    if (
      parsed.output.encoding !== "base64" ||
      parsed.output.content === undefined
    ) {
      return err({ _tag: "GitHubReadFailed", operation: "get_file" });
    }
    const contents = Buffer.from(
      parsed.output.content.replaceAll("\n", ""),
      "base64",
    );
    if (contents.byteLength > maxHydratedFileBytes) {
      return ok({ state: "too_large" });
    }
    if (contents.includes(0)) return ok({ state: "binary" });
    return ok({ state: "available", contents: contents.toString("utf8") });
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    const response = await this.ghText(profile, {
      // `gh auth status` exits nonzero if any stale, inactive account is
      // invalid, even when the configured active account can make API calls.
      // Ask GitHub who this invocation can actually authenticate as instead.
      argv: [
        "gh",
        "api",
        "--hostname",
        profile.githubHost,
        "user",
        "--jq",
        ".login",
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (
      response._tag === "err" ||
      response.value.trim() !== profile.ghAccount
    ) {
      return err({
        _tag: "GitHubAuthenticationFailed",
        operation: "auth_status",
      });
    }
    return ok({ host: profile.githubHost, account: profile.ghAccount });
  }

  async createPendingReview(input: {
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
  > {
    if (input.comments.length === 0 && input.summaryBody.trim().length === 0)
      return err({
        _tag: "GitHubWriteFailure",
        category: "rejected",
        message: "No review content is selected.",
      });
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "POST",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({
        commit_id: input.headSha,
        body: input.summaryBody,
        comments: input.comments.map(toGitHubReviewComment),
      }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const receipt = v.safeParse(reviewReceiptSchema, response.value);
    const pending = receipt.success
      ? parsePendingReview(receipt.output)
      : undefined;
    return pending === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "GitHub did not return a PENDING review.",
        })
      : ok(pending);
  }

  async submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "POST",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews/${input.reviewId}/events`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({ event: input.event, body: input.summaryBody }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const submitted = v.safeParse(reviewReceiptSchema, response.value);
    const reviewId = submitted.success
      ? parseReviewId(submitted.output.id)
      : undefined;
    return reviewId === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "GitHub did not return a submitted review ID.",
        })
      : ok({ reviewId });
  }

  async createDirectSummaryReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly event: GitHubReviewEvent;
    readonly body: string;
  }): Promise<Result<DirectSummaryReviewReceipt, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "POST",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({
        commit_id: input.headSha,
        event: input.event,
        body: input.body,
      }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return err(directSummaryWriteFailure(response.error));
    const raw = v.safeParse(directSummaryReceiptSchema, response.value);
    const receipt = raw.success
      ? parseDirectSummaryReceipt(raw.output, input.event)
      : undefined;
    return receipt === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "GitHub did not return a submitted summary review receipt.",
        })
      : ok(receipt);
  }

  async getViewerDirectSummaryReviews(input: {
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
  > {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews?per_page=100&page=1`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_direct_summary_reviews",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(publishedReviewSchema, response.value);
    if (!parsed.success) return invalid("get_direct_summary_reviews");
    const reviews: DirectSummaryPublishedReview[] = [];
    for (const raw of parsed.output) {
      if (
        raw.user?.login !== input.account ||
        raw.submitted_at === undefined ||
        raw.submitted_at === null
      )
        continue;
      if (raw.state === "DISMISSED") continue;
      const event = directSummaryEvent(raw.state);
      const reviewId = parseGitHubReviewRestId(String(raw.id));
      const headSha =
        raw.commit_id === undefined || raw.commit_id === null
          ? undefined
          : parseGitSha(raw.commit_id);
      const submittedAt = parseGitHubTimestamp(raw.submitted_at);
      if (
        event === undefined ||
        reviewId._tag === "err" ||
        headSha === undefined ||
        headSha._tag === "err" ||
        submittedAt._tag === "err"
      )
        return invalid("get_direct_summary_reviews");
      reviews.push({
        reviewId: reviewId.value,
        event,
        headSha: headSha.value,
        submittedAt: submittedAt.value,
        bodyDigest: digestReviewBody(raw.body ?? ""),
      });
    }
    return ok({ reviews, complete: parsed.output.length < 100 });
  }

  async getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>> {
    const reviews = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews?per_page=100&page=1`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (reviews._tag === "err")
      return this.commandFailure(
        "get_pending_review",
        reviews.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(publishedReviewSchema, reviews.value);
    if (!parsed.success) return invalid("get_pending_review");
    const pending = parsed.output.filter(
      (review) =>
        review.state === "PENDING" && review.user?.login === input.account,
    );
    if (pending.length === 0) {
      // None is provable only with a complete bounded result; an incomplete
      // page is Unavailable, never proof that no pending review exists.
      return parsed.output.length < 100
        ? ok({ _tag: "None" })
        : invalid("get_pending_review");
    }
    if (pending.length > 1) return invalid("get_pending_review");
    const rawReview = pending[0];
    if (rawReview === undefined) return invalid("get_pending_review");
    const restId = parseReviewId(rawReview.id);
    const nodeId = rawReview.node_id;
    const commitId = rawReview.commit_id;
    const parsedRestId =
      restId === undefined
        ? err({ _tag: "InvalidDomainValue" as const, field: "reviewRestId" })
        : parseGitHubReviewRestId(restId);
    const parsedNodeId =
      nodeId === undefined
        ? err({ _tag: "InvalidDomainValue" as const, field: "reviewNodeId" })
        : parseGitHubReviewNodeId(nodeId);
    const parsedCommit =
      commitId === undefined || commitId === null
        ? err({ _tag: "InvalidDomainValue" as const, field: "reviewCommitId" })
        : parseGitSha(commitId);
    if (
      parsedRestId._tag === "err" ||
      parsedNodeId._tag === "err" ||
      parsedCommit._tag === "err"
    ) {
      return invalid("get_pending_review");
    }

    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${pendingReviewThreadsQuery}`,
        "-F",
        `owner=${input.pr.owner}`,
        "-F",
        `name=${input.pr.repo}`,
        "-F",
        `number=${input.pr.number}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_pending_review",
        response.error,
        input.profile.githubHost,
      );
    const threads = v.safeParse(
      pendingReviewThreadsResponseSchema,
      response.value,
    );
    if (!threads.success) return invalid("get_pending_review");
    const connection = threads.output.data.repository.pullRequest.reviewThreads;
    if (connection.pageInfo?.hasNextPage === true)
      return invalid("get_pending_review");

    const comments: Array<ViewerPendingReview["comments"][number]> = [];
    for (const thread of connection.nodes) {
      if (thread.comments.pageInfo?.hasNextPage === true)
        return invalid("get_pending_review");
      for (const comment of thread.comments.nodes) {
        // Only comments owned by a PENDING review of the authenticated viewer
        // are actionable. The single-pending-review-per-PR rule plus the
        // owning-review state prove the thread belongs to this review without
        // matching node IDs across the REST/GraphQL boundaries.
        if (
          comment.pullRequestReview === undefined ||
          comment.pullRequestReview.state !== "PENDING"
        )
          continue;
        if (comment.author?.login !== input.account) continue;
        const reviewCommentId = parseGitHubReviewCommentId(comment.id);
        const threadId = parseGitHubThreadId(thread.id);
        const createdAt = parseGitHubTimestamp(comment.createdAt);
        const anchor = pendingReviewAnchor(thread);
        if (
          reviewCommentId._tag === "err" ||
          threadId._tag === "err" ||
          createdAt._tag === "err" ||
          anchor === undefined
        ) {
          return invalid("get_pending_review");
        }
        comments.push({
          reviewCommentId: reviewCommentId.value,
          threadId: threadId.value,
          body: comment.body,
          anchor,
          createdAt: createdAt.value,
        });
      }
    }
    // A pending review with no actionable comments is the unproven empty-review
    // case; it must not look like an importable owner.
    if (comments.length === 0) return invalid("get_pending_review");
    const sortedCreatedAt = comments.map((comment) => comment.createdAt).sort();
    const createdAt = sortedCreatedAt[0];
    const updatedAt = sortedCreatedAt[sortedCreatedAt.length - 1];
    if (createdAt === undefined || updatedAt === undefined)
      return invalid("get_pending_review");
    return ok({
      _tag: "Pending",
      review: {
        restId: parsedRestId.value,
        nodeId: parsedNodeId.value,
        author: input.account,
        pr: input.pr,
        headSha: parsedCommit.value,
        comments,
        createdAt,
        updatedAt,
      },
    });
  }

  async startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    const created = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "POST",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({
        commit_id: input.headSha,
        body: input.body,
        comments: [pendingReviewComment(input.anchor, input.body)],
      }),
      timeoutMs: commandTimeoutMs,
    });
    if (created._tag === "err") return err(writeFailure(created.error));
    const receipt = v.safeParse(reviewReceiptSchema, created.value);
    const pending = receipt.success
      ? parsePendingReview(receipt.output)
      : undefined;
    const written = v.safeParse(writtenNodeSchema, created.value);
    if (pending === undefined || !written.success) {
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub did not return a PENDING review identity.",
      });
    }
    // The create receipt is not a full owner: thread and comment identity come
    // only from the proven bounded read-back. A failed read-back leaves the
    // confirmed remote create unreconciled rather than inventing identities.
    return this.pendingReviewAfterWrite(input.profile, input.pr, {
      restId: pending.reviewId,
      nodeId: written.output.node_id,
      anchor: input.anchor,
      body: input.body,
    });
  }

  async addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    const side = input.anchor.side === "new" ? "RIGHT" : "LEFT";
    // pageInfo belongs inside the comments connection: PullRequestReviewThread
    // has no pageInfo field, and GitHub rejects the mutation at schema
    // validation before executing it. The read-back never runs in that case.
    const appendQuery = `mutation($reviewId:ID!,$path:String!,$line:Int!,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$reviewId,path:$path,line:$line,side:${side},body:$body}){thread{id path line startLine diffSide comments(first:100){nodes{id body} pageInfo{hasNextPage}}}}}`;
    const appended = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${appendQuery}`,
        "-F",
        `reviewId=${input.reviewId}`,
        "-F",
        `path=${input.anchor.path}`,
        "-F",
        `line=${input.anchor.line}`,
        "-f",
        `body=${input.body}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (appended._tag === "err") return err(writeFailure(appended.error));
    const added = v.safeParse(addedReviewThreadSchema, appended.value);
    const thread = added.success
      ? added.output.data.addPullRequestReviewThread.thread
      : undefined;
    if (thread === undefined || thread.comments.nodes[0] === undefined) {
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub did not return a thread identity.",
      });
    }
    return this.pendingReviewAfterWrite(input.profile, input.pr, {
      nodeId: input.reviewId,
      createdThreadId: thread.id,
    });
  }

  /** Read the confirmed owner after a write; an unreconciled write is unavailable. */
  private async pendingReviewAfterWrite(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
    expected: {
      readonly restId?: string;
      readonly nodeId?: string;
      readonly createdThreadId?: string;
      readonly createdCommentId?: string;
      readonly anchor?: PendingReviewAnchor;
      readonly body?: string;
    },
  ): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    const account = parseGitHubLogin(profile.ghAccount);
    if (account._tag === "err") {
      return err({
        _tag: "GitHubWriteFailure",
        category: "auth",
        message: "GitHub authentication is required.",
      });
    }
    const parsedCreatedThread =
      expected.createdThreadId === undefined
        ? undefined
        : parseGitHubThreadId(expected.createdThreadId);
    const read = await this.getViewerPendingReview({
      profile,
      pr,
      account: account.value,
    });
    const matches =
      read._tag === "ok" &&
      read.value._tag === "Pending" &&
      (expected.restId === undefined ||
        read.value.review.restId === expected.restId) &&
      (expected.nodeId === undefined ||
        read.value.review.nodeId === expected.nodeId);
    if (!matches) {
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "The pending review could not be confirmed after the write.",
      });
    }
    const expectedAnchor = expected.anchor;
    const expectedBody = expected.body;
    const matchingThreads =
      expectedAnchor === undefined || expectedBody === undefined
        ? []
        : read.value.review.comments.filter(
            (comment) =>
              comment.body === expectedBody &&
              samePendingReviewAnchor(comment.anchor, expectedAnchor),
          );
    const createdThread =
      expected.createdThreadId === undefined
        ? expected.createdCommentId === undefined
          ? matchingThreads.length === 1
            ? matchingThreads[0]?.threadId
            : undefined
          : read.value.review.comments.find(
              (comment) =>
                comment.reviewCommentId === expected.createdCommentId,
            )?.threadId
        : parsedCreatedThread?._tag === "ok"
          ? parsedCreatedThread.value
          : undefined;
    if (
      createdThread !== undefined &&
      read.value.review.comments.some(
        (comment) => comment.threadId === createdThread,
      )
    ) {
      return ok({
        review: read.value.review,
        createdThreadId: createdThread,
      });
    }
    return err({
      _tag: "GitHubWriteFailure",
      category: "unavailable",
      message: "GitHub did not confirm the created review thread.",
    });
  }

  /**
   * Bounded, retried proof that a REST-created comment belongs to a
   * confirmed, published review thread. Reuses `pendingReviewAfterWrite`'s
   * discipline (never upgrade without proof) for a published rather than
   * pending comment: up to 3 attempts (500ms then 1500ms backoff for
   * eventual consistency), each reading the 20 most-recently-created
   * threads and matching by comment id equality (the same REST
   * `node_id`-as-GraphQL-node-id equivalence already relied on by
   * `getReviewCommentTarget`), with a body match as cheap defense-in-depth.
   * A transport/command error stops the read-back immediately rather than
   * retrying a hard failure. Never fabricates an id: returns `undefined`
   * on any unconfirmed or exhausted outcome, and the caller must not fail
   * the write over it — the comment was already posted successfully.
   */
  private async confirmPublishedCommentThread(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
    input: { readonly commentId: string; readonly body: string },
  ): Promise<GitHubThreadId | undefined> {
    const backoffsMs = [0, 500, 1500];
    for (const backoffMs of backoffsMs) {
      if (backoffMs > 0) await wait(backoffMs);
      const response = await this.ghJson(profile, {
        argv: [
          "gh",
          "api",
          "graphql",
          "--hostname",
          profile.githubHost,
          "-f",
          `query=${confirmCreatedCommentThreadQuery}`,
          "-F",
          `owner=${pr.owner}`,
          "-F",
          `name=${pr.repo}`,
          "-F",
          `number=${pr.number}`,
        ],
        timeoutMs: commandTimeoutMs,
      });
      if (response._tag === "err") return undefined;
      const parsed = v.safeParse(threadResponseSchema, response.value);
      if (!parsed.success) continue;
      for (const thread of parsed.output.data.repository.pullRequest
        .reviewThreads.nodes) {
        const match = thread.comments.nodes.find(
          (comment) => comment.id === input.commentId,
        );
        if (match === undefined || match.body !== input.body) continue;
        const threadId = parseGitHubThreadId(thread.id);
        if (threadId._tag === "ok") return threadId.value;
      }
    }
    return undefined;
  }

  async discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>> {
    // The DELETE endpoint answers 204 with an empty body, so this boundary
    // uses runText: any exit-0 response is the confirmed absence receipt, and
    // GitHub's HTTP error exits classify as typed failures. Never retried by
    // the caller; a timeout is an unavailable outcome.
    const response = await this.ghText(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "DELETE",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews/${input.reviewId}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    return ok(undefined);
  }

  async createInlineComment(input: {
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
  > {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "POST",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/comments`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({
        body: input.body,
        commit_id: input.headSha,
        ...input.coordinates,
      }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const created = v.safeParse(createdInlineCommentSchema, response.value);
    if (!created.success)
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub did not return an inline comment ID.",
      });
    // A create submits a COMMENTED review of its own; its id lets the write
    // journal exclude that review from update detection.
    const rawReviewId = created.output.pull_request_review_id;
    const reviewId =
      rawReviewId === null || rawReviewId === undefined
        ? undefined
        : String(rawReviewId);
    // The REST create receipt has no thread id on its own, so a bounded,
    // retried read-back (`confirmPublishedCommentThread`) attempts to prove
    // the published thread this comment landed in, upgrading Reply/Resolve
    // in the same round trip. A failed or exhausted read-back degrades the
    // receipt (no `threadId`) instead of failing the write — the comment was
    // already posted successfully, and the card falls back to an explicit
    // refresh. The comment itself remains editable and deletable by its
    // authoritative node id regardless of the read-back's outcome.
    const receipt = { commentId: created.output.node_id };
    const withReviewId =
      reviewId === undefined || reviewId.length === 0
        ? receipt
        : { ...receipt, reviewId };
    const threadId = await this.confirmPublishedCommentThread(
      input.profile,
      input.pr,
      { commentId: created.output.node_id, body: input.body },
    );
    return ok(
      threadId === undefined ? withReviewId : { ...withReviewId, threadId },
    );
  }

  async createThreadReply(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly body: string;
  }): Promise<
    Result<
      { readonly commentId: string; readonly reviewId?: string },
      GitHubWriteFailure
    >
  > {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        "query=mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id pullRequestReview{id}}}}",
        "-F",
        `threadId=${input.threadId}`,
        "-f",
        `body=${input.body}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const replied = v.safeParse(addedThreadReplySchema, response.value);
    const comment = replied.success
      ? replied.output.data.addPullRequestReviewThreadReply.comment
      : undefined;
    if (comment === undefined || comment.id.length === 0)
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub did not return a reply ID.",
      });
    // A reply also submits its own COMMENTED review; expose it so the write
    // journal can exclude it from update detection.
    const reviewId = comment.pullRequestReview?.id;
    const receipt = { commentId: comment.id };
    return ok(
      reviewId === undefined || reviewId.length === 0
        ? receipt
        : { ...receipt, reviewId },
    );
  }

  async setReviewThreadState(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly state: "resolved" | "open";
  }): Promise<Result<void, GitHubWriteFailure>> {
    const mutation =
      input.state === "resolved"
        ? "resolveReviewThread"
        : "unresolveReviewThread";
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=mutation($threadId:ID!){${mutation}(input:{threadId:$threadId}){thread{id}}}`,
        "-F",
        `threadId=${input.threadId}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async addLabelsToLabelable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${addLabelsToLabelableMutation}`,
        "-F",
        `labelableId=${input.labelableId}`,
        ...input.labelIds.flatMap((labelId) => ["-F", `labelIds[]=${labelId}`]),
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async removeLabelsFromLabelable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${removeLabelsFromLabelableMutation}`,
        "-F",
        `labelableId=${input.labelableId}`,
        ...input.labelIds.flatMap((labelId) => ["-F", `labelIds[]=${labelId}`]),
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async addAssigneesToAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${addAssigneesToAssignableMutation}`,
        "-F",
        `assignableId=${input.assignableId}`,
        ...input.assigneeIds.flatMap((assigneeId) => [
          "-F",
          `assigneeIds[]=${assigneeId}`,
        ]),
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async removeAssigneesFromAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${removeAssigneesFromAssignableMutation}`,
        "-F",
        `assignableId=${input.assignableId}`,
        ...input.assigneeIds.flatMap((assigneeId) => [
          "-F",
          `assigneeIds[]=${assigneeId}`,
        ]),
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async requestReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly userIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${requestReviewsMutation}`,
        "-F",
        `pullRequestId=${input.pullRequestId}`,
        ...input.userIds.flatMap((userId) => ["-F", `userIds[]=${userId}`]),
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  /**
   * Removes named people from a pull request's requested-reviewer set via
   * the REST endpoint's own subtractive semantics (`DELETE
   * .../requested_reviewers` with a `{ reviewers: [...] }` body removes only
   * the named logins) — see the asymmetry explained on
   * `GitHubReviewWriter.removeRequestedReviewers`. `--method DELETE` +
   * `--input -` + `stdin: JSON.stringify(...)` copies `updateReviewComment`'s
   * argv shape for a body-carrying non-GET request.
   */
  async removeRequestedReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly logins: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "DELETE",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/requested_reviewers`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({ reviewers: input.logins }),
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async updateThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        "query=mutation($commentId:ID!,$body:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$commentId,body:$body}){pullRequestReviewComment{id}}}",
        "-F",
        `commentId=${input.commentId}`,
        "-f",
        `body=${input.body}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async deleteThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        "query=mutation($commentId:ID!){deletePullRequestReviewComment(input:{id:$commentId}){clientMutationId}}",
        "-F",
        `commentId=${input.commentId}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async updateReviewComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "PATCH",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/comments/${input.commentId}`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({ body: input.body }),
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async deleteReviewComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "DELETE",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/comments/${input.commentId}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async dismissReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly message: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "PUT",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews/${input.reviewId}/dismissals`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({ message: input.message }),
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<
    Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>
  > {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "PUT",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/merge`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({ sha: input.headSha, merge_method: input.method }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const merge = v.safeParse(mergeResultSchema, response.value);
    if (!merge.success || !merge.output.merged)
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub did not confirm the merge.",
      });
    const rawSha = merge.output.sha;
    const sha =
      rawSha === undefined || rawSha === null ? undefined : parseGitSha(rawSha);
    return sha !== undefined && sha._tag === "err"
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "GitHub returned an invalid merge commit.",
        })
      : ok(sha === undefined ? {} : { mergeCommitSha: sha.value });
  }

  private async verifyFetchedRefs(
    refs: FetchedDiffRefs,
  ): Promise<Result<void, GitHubReadFailure>> {
    const base = await this.resolveFetchedRef(
      refs.repositoryPath,
      refs.baseRef,
    );
    if (base._tag === "err" || base.value !== refs.baseSha) {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    const head = await this.resolveFetchedRef(
      refs.repositoryPath,
      refs.headRef,
    );
    if (head._tag === "err" || head.value !== refs.headSha) {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    return ok(undefined);
  }

  private async resolveFetchedRef(
    repositoryPath: AbsolutePath,
    ref: string,
  ): Promise<Result<GitSha, GitHubReadFailure>> {
    const response = await this.commands.runText({
      argv: [
        "git",
        "-C",
        repositoryPath,
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${ref}^{commit}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    const sha = parseGitSha(response.value.trim());
    return sha._tag === "ok"
      ? sha
      : err({ _tag: "GitHubReadFailed", operation: "get_diff" });
  }

  async loadConversation(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<Conversation, GitHubReadFailure>> {
    const [prResult, commentsResult, feedbackResult] = await Promise.all([
      this.getPullRequest(input),
      this.getPullRequestComments(input),
      this.getPullRequestPublishedFeedback?.(input) ??
        Promise.resolve(ok({ reviews: [], comments: [] })),
    ]);
    if (commentsResult._tag === "err") return commentsResult;
    if (feedbackResult._tag === "err") return feedbackResult;
    const prDescription =
      prResult._tag === "ok" ? (prResult.value.description ?? "") : "";
    return ok(
      this.assembleConversation(
        prDescription,
        feedbackResult.value,
        commentsResult.value,
      ),
    );
  }

  private assembleConversation(
    prDescription: string,
    feedback: GitHubPublishedFeedback,
    comments: GitHubComments,
  ): Conversation {
    const entries: Conversation["entries"][number][] = [];
    for (const review of feedback.reviews) {
      entries.push({ _tag: "ReviewSummary" as const, review });
    }
    for (const comment of feedback.comments) {
      entries.push({ _tag: "IssueComment" as const, comment });
    }
    for (const thread of comments.threads) {
      if (thread.location !== undefined) continue;
      entries.push({ _tag: "GeneralThread" as const, thread });
    }
    let inline: GitHubComments = {
      threads: comments.threads.filter(
        (thread) => thread.location !== undefined,
      ),
    };
    if (comments.complete !== undefined)
      inline = { ...inline, complete: comments.complete };
    if (comments.incompleteReason !== undefined)
      inline = { ...inline, incompleteReason: comments.incompleteReason };
    entries.sort((a, b) => {
      const at =
        a._tag === "ReviewSummary"
          ? a.review.submittedAt
          : a._tag === "IssueComment"
            ? a.comment.createdAt
            : a._tag === "GeneralThread"
              ? (a.thread.comments[0]?.createdAt ?? "")
              : "";
      const bt =
        b._tag === "ReviewSummary"
          ? b.review.submittedAt
          : b._tag === "IssueComment"
            ? b.comment.createdAt
            : b._tag === "GeneralThread"
              ? (b.thread.comments[0]?.createdAt ?? "")
              : "";
      return at.localeCompare(bt);
    });
    return {
      prDescription,
      entries,
      inline,
      complete: feedback.complete !== false && comments.complete !== false,
    };
  }
}

export {
  FakeGitHubAdapter,
  type FakeGitHubAdapterValues,
} from "./fake-github-adapter";

/** Backoff delay for `confirmPublishedCommentThread`'s retried read-back. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
