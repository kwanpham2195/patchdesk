import * as v from "valibot";

import type { CommandFailure, CommandRunner } from "./command-runner";
import {
  commandTimeoutMs,
  type GhCommandRequest,
  GhRequestRunner,
  type GitHubReadFailure,
} from "./gh-request-runner";
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "./github-credentials";
import { GitHubPullRequestReader } from "./github-pull-request-reader";
import { GitHubThreadReader } from "./github-threads";
import { GitHubThreadWriter } from "./github-thread-writer";
import {
  GitHubMergePolicyReader,
  type KnownRepositoryRole,
} from "./github-merge-policy";
import { GitHubPendingReviews } from "./github-pending-review";
import { GitHubConversationReader } from "./github-conversation";
import { GitHubDiffReader } from "./github-diff-reader";
import { GitHubCollaborators } from "./github-collaborators";
import type {
  AssignableUserListing,
  CheckSummary,
  Conversation,
  GitHubComments,
  GitHubMergePolicyEvidence,
  GitHubPublishedFeedback,
  MaintainerPullRequestPage,
  MaintainerPullRequestSearchPage,
  MergePolicySnapshot,
  PullRequestAssigneePermission,
  PullRequestCommit,
  PullRequestReviewerListing,
  PullRequestSummary,
  RepositoryLabelListing,
  RepositoryLabelPermission,
} from "../../domain/github-context";
import type {
  AbsolutePath,
  GitHubLogin,
  GitHubReviewNodeId,
  GitHubReviewRestId,
  GitHubThreadId,
  GitSha,
  IsoTimestamp,
  RepoRelativePath,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import type {
  InboxPageSize,
  InboxStateFilter,
} from "../../domain/maintainer-inbox";
import { err, ok, type Result } from "../../domain/result";
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
import { reviewReceiptSchema } from "./github-wire-schemas";
import {
  isManagedFetchedRef,
  parsePendingReview,
  parseReviewId,
  toGitHubReviewComment,
} from "./github-wire-projections";
import { writeFailure } from "./github-write-failures";

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
 * this change's state import that type name directly). Renamed from
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
export type {
  GitHubReadFailure,
  GitHubReadOperation,
} from "./gh-request-runner";

/**
 * GitHub CLI external adapter. It owns all gh execution and returns parsed, safe projections.
 * Read operations and explicit review writes live in the main process; renderer code never reaches this adapter.
 */
export class GitHubAdapter
  implements
    GitHubReader,
    GitHubReviewWriter,
    GitHubMergeWriter,
    GitHubDirectSummaryGateway,
    GitHubPendingReviewGateway
{
  private readonly requests: GhRequestRunner;
  private readonly pullRequests: GitHubPullRequestReader;
  private readonly threads: GitHubThreadReader;
  private readonly threadWrites: GitHubThreadWriter;
  private readonly mergePolicy: GitHubMergePolicyReader;
  private readonly pendingReviews: GitHubPendingReviews;
  private readonly conversation: GitHubConversationReader;
  private readonly diffs: GitHubDiffReader;
  private readonly collaborators: GitHubCollaborators;

  constructor(
    commands: CommandRunner,
    credentials: GitHubCredentials = new GitHubCliCredentials(commands),
  ) {
    this.requests = new GhRequestRunner(commands, credentials);
    this.pullRequests = new GitHubPullRequestReader(this.requests);
    this.threads = new GitHubThreadReader(this.requests);
    this.threadWrites = new GitHubThreadWriter(this.requests);
    this.mergePolicy = new GitHubMergePolicyReader(this.requests);
    this.pendingReviews = new GitHubPendingReviews(this.requests);
    this.diffs = new GitHubDiffReader(this.requests, commands);
    this.collaborators = new GitHubCollaborators(this.requests);
    this.conversation = new GitHubConversationReader(
      this.requests,
      this.pullRequests,
      this.threads,
      this.mergePolicy,
      this,
    );
  }

  /** Run a gh command that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
  }

  /** Run a gh command that returns text as the profile's configured GitHub account. */
  private async ghText(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<string, CommandFailure>> {
    return this.requests.ghText(profile, request);
  }

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    return this.pullRequests.listOpenPullRequests(input);
  }

  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly state?: InboxStateFilter;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestPage, GitHubReadFailure>> {
    return this.pullRequests.listMaintainerPullRequests(input);
  }

  async searchMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly searchQuery: string;
    readonly state: InboxStateFilter;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestSearchPage, GitHubReadFailure>> {
    return this.pullRequests.searchMaintainerPullRequests(input);
  }

  async listRepositoryLabels(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<RepositoryLabelListing, GitHubReadFailure>> {
    return this.collaborators.listRepositoryLabels(input);
  }

  async listAssignableUsers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
    readonly query?: string;
  }): Promise<Result<AssignableUserListing, GitHubReadFailure>> {
    return this.collaborators.listAssignableUsers(input);
  }

  async getPullRequestReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestReviewerListing, GitHubReadFailure>> {
    return this.collaborators.getPullRequestReviewers(input);
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    return this.pullRequests.getPullRequest(input);
  }

  async getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>> {
    return this.mergePolicy.getMergePolicy(input);
  }

  async getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>> {
    return this.pullRequests.getMergeOutcome(input);
  }

  async getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>> {
    return this.pullRequests.getPullRequestCommits(input);
  }

  async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    return this.threads.getPullRequestComments(input);
  }

  async getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>> {
    return this.threads.getReviewThreadTarget(input);
  }

  async getReviewCommentTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>> {
    return this.threads.getReviewCommentTarget(input);
  }

  async getPullRequestPublishedFeedback(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>> {
    return this.conversation.getPullRequestPublishedFeedback(input);
  }

  async getRepositoryPermission(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: string;
  }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>> {
    return this.mergePolicy.getRepositoryPermission(input);
  }

  async getBranchProtection(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>> {
    return this.mergePolicy.getBranchProtection(input);
  }

  async getMergePolicyEvidence(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>> {
    return this.mergePolicy.getMergePolicyEvidence(input);
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    return this.diffs.getPullRequestChecks(input);
  }

  async getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    /** Immutable remote comparison used only when no managed checkout exists. */
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>> {
    return this.diffs.getPullRequestDiff(input);
  }

  async getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>> {
    return this.diffs.getFileContents(input);
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
    return this.conversation.createDirectSummaryReview(input);
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
    return this.conversation.getViewerDirectSummaryReviews(input);
  }

  async getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>> {
    return this.pendingReviews.getViewerPendingReview(input);
  }

  async startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    return this.pendingReviews.startPendingReviewWithThread(input);
  }

  async addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    return this.pendingReviews.addPendingReviewThread(input);
  }

  async discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.pendingReviews.discardPendingReview(input);
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
    return this.threadWrites.createInlineComment(input);
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
    return this.threadWrites.createThreadReply(input);
  }

  async setReviewThreadState(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly state: "resolved" | "open";
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.threadWrites.setReviewThreadState(input);
  }

  async addLabelsToLabelable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.collaborators.addLabelsToLabelable(input);
  }

  async removeLabelsFromLabelable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.collaborators.removeLabelsFromLabelable(input);
  }

  async addAssigneesToAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.collaborators.addAssigneesToAssignable(input);
  }

  async removeAssigneesFromAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.collaborators.removeAssigneesFromAssignable(input);
  }

  async requestReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly userIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.collaborators.requestReviews(input);
  }

  async removeRequestedReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly logins: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.collaborators.removeRequestedReviewers(input);
  }

  async updateThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.threadWrites.updateThreadComment(input);
  }

  async deleteThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.threadWrites.deleteThreadComment(input);
  }

  async updateReviewComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.threadWrites.updateReviewComment(input);
  }

  async deleteReviewComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.threadWrites.deleteReviewComment(input);
  }

  async dismissReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
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
    return this.mergePolicy.mergePullRequest(input);
  }

  async loadConversation(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<Conversation, GitHubReadFailure>> {
    return this.conversation.loadConversation(input);
  }
}

export { FakeGitHubAdapter } from "./fake-github-adapter";
