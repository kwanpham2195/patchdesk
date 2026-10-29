import { readConnectedGitHub, writeConnectedGitHub } from "./github-connection";
import * as v from "valibot";

import type { CommandFailure, CommandRunner } from "./command-runner";
import {
  GhRequestRunner,
  type GitHubReadFailure,
  type GitHubServedTransport,
} from "./gh-request-runner";
import type { GitHubRequest } from "./github-request";
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "./github-credentials";
import { GitHubPullRequestReader } from "./github-pull-request-reader";
import { GitHubThreadReader } from "./github-threads";
import { GitHubThreadWriter } from "./github-thread-writer";
import {
  type BranchProtectionRead,
  GitHubMergePolicyReader,
  type KnownRepositoryRole,
} from "./github-merge-policy";
import {
  type PullRequestReviewsRead,
  readPullRequestReviews,
} from "./github-pull-request-reviews";
import { GitHubPendingReviews } from "./github-pending-review";
import { GitHubConversationReader } from "./github-conversation";
import { GitHubDiffReader } from "./github-diff-reader";
import { GitHubCollaborators } from "./github-collaborators";
import type {
  AssignableUserListing,
  CheckSummary,
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
} from "#src/domain/github-context";
import type {
  AbsolutePath,
  GitHubLogin,
  GitHubReviewNodeId,
  GitHubReviewRestId,
  GitHubThreadId,
  GitSha,
  IsoTimestamp,
  RepoRelativePath,
} from "#src/domain/ids";
import type { PullRequestRef } from "#src/domain/pull-request";
import type {
  InboxPageSize,
  InboxStateFilter,
} from "#src/domain/maintainer-inbox";
import { err, ok, type Result } from "#src/domain/result";
import {
  type WorkspaceProfileConfig,
  isConnectedWorkspaceProfile,
} from "#src/domain/workspace-profile";
import type {
  GitHubReviewEvent,
  PendingReviewAnchor,
  PendingReviewRead,
  PendingReviewThreadWrite,
} from "#src/domain/pending-review";
import type { DirectSummaryReviewReceipt } from "#src/domain/direct-summary-review";
import type { GitHubWriteFailure } from "#src/domain/github-write";
import type { GitHubReviewCoordinates } from "#src/domain/patch";
import {
  authenticatedUserSchema,
  reviewReceiptSchema,
} from "./github-wire-schemas";
import { isManagedFetchedRef, parseReviewId } from "./github-wire-projections";
import { writeFailure } from "./github-write-failures";
import type {
  DirectSummaryPublishedReview,
  GitHubCommentTarget,
  GitHubDirectSummaryGateway,
  GitHubFileContents,
  GitHubMergeWriter,
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReviewWriter,
  GitHubThreadTarget,
  MergeOutcome,
  RepositoryBranchListing,
  WatchedPullRequestRead,
} from "./github-ports";

/** The GitHub port declarations this adapter implements. */
export type {
  DirectSummaryPublishedReview,
  GitHubCommentTarget,
  GitHubDirectSummaryGateway,
  GitHubFileContents,
  GitHubMergeWriter,
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReviewWriter,
  GitHubThreadTarget,
  MergeOutcome,
  RepositoryBranchListing,
  WatchedPullRequestRead,
} from "./github-ports";

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

/**
 * Which rendering a diff read is taken from. Exactly one is required, so
 * `getPullRequestDiff` cannot be asked for a diff it has no source for
 * (issue #293).
 */
export type PullRequestDiffSource =
  | { readonly fetchedRefs: FetchedDiffRefs; readonly snapshot?: undefined }
  | {
      readonly fetchedRefs?: undefined;
      /** Immutable remote comparison used only when no managed checkout exists. */
      readonly snapshot: {
        readonly baseSha: GitSha;
        readonly headSha: GitSha;
      };
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
  private readonly credentials: GitHubCredentials;

  constructor(
    commands: CommandRunner,
    credentials: GitHubCredentials = new GitHubCliCredentials(commands),
    /** Serves every GitHub API request this adapter makes (ADR 0046, issue #276). */
    http: GitHubServedTransport,
  ) {
    this.credentials = credentials;
    this.requests = new GhRequestRunner(http);
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
      this.mergePolicy,
      this,
    );
  }

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    if (!isConnectedWorkspaceProfile(profile))
      return err({ _tag: "CommandAuthenticationRequired" });

    return this.requests.ghJson(profile, request);
  }

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pullRequests.listOpenPullRequests(connectedInput),
    );
  }

  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly state?: InboxStateFilter;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestPage, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pullRequests.listMaintainerPullRequests(connectedInput),
    );
  }

  async searchMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly searchQuery: string;
    readonly state: InboxStateFilter;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestSearchPage, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pullRequests.searchMaintainerPullRequests(connectedInput),
    );
  }

  async listRepositoryLabels(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<RepositoryLabelListing, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.collaborators.listRepositoryLabels(connectedInput),
    );
  }

  async listAssignableUsers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
    readonly query?: string;
  }): Promise<Result<AssignableUserListing, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.collaborators.listAssignableUsers(connectedInput),
    );
  }

  async readWatchedPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly refs: ReadonlyArray<PullRequestRef>;
    readonly now: IsoTimestamp;
  }): Promise<
    Result<ReadonlyArray<WatchedPullRequestRead>, GitHubReadFailure>
  > {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pullRequests.readWatchedPullRequests(connectedInput),
    );
  }

  async listRepositoryBranches(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly query?: string;
  }): Promise<Result<RepositoryBranchListing, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pullRequests.listRepositoryBranches(connectedInput),
    );
  }

  async getPullRequestReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestReviewerListing, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.collaborators.getPullRequestReviewers(connectedInput),
    );
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pullRequests.getPullRequest(connectedInput),
    );
  }

  async getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.mergePolicy.getMergePolicy(connectedInput),
    );
  }

  async getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pullRequests.getMergeOutcome(connectedInput),
    );
  }

  async getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha?: GitSha;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pullRequests.getPullRequestCommits(connectedInput),
    );
  }

  async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.threads.getPullRequestComments(connectedInput),
    );
  }

  async getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.threads.getReviewThreadTarget(connectedInput),
    );
  }

  async getReviewCommentTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.threads.getReviewCommentTarget(connectedInput),
    );
  }

  async getPullRequestPublishedFeedback(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly baseBranch?: string;
    readonly branchProtection?: BranchProtectionRead;
    readonly reviews?: PullRequestReviewsRead;
  }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.conversation.getPullRequestPublishedFeedback(connectedInput),
    );
  }

  async readPullRequestReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<PullRequestReviewsRead> {
    if (!isConnectedWorkspaceProfile(input.profile))
      return {
        _tag: "Unreadable",
        failure: { _tag: "CommandAuthenticationRequired" },
      };
    const connectedInput = { ...input, profile: input.profile };

    return readPullRequestReviews(this.requests, connectedInput);
  }

  async getRepositoryPermission(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: string;
  }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.mergePolicy.getRepositoryPermission(connectedInput),
    );
  }

  async getBranchProtection(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.mergePolicy.getBranchProtection(connectedInput),
    );
  }

  async readBranchProtection(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<BranchProtectionRead> {
    if (!isConnectedWorkspaceProfile(input.profile))
      return {
        dismissal: err({
          _tag: "GitHubAuthenticationFailed",
          operation: "auth_status",
        }),
        evidence: err({
          _tag: "GitHubAuthenticationFailed",
          operation: "auth_status",
        }),
      };
    const connectedInput = { ...input, profile: input.profile };

    return this.mergePolicy.readBranchProtection(connectedInput);
  }

  async getMergePolicyEvidence(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
    readonly branchProtection?: BranchProtectionRead;
  }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.mergePolicy.getMergePolicyEvidence(connectedInput),
    );
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.diffs.getPullRequestChecks(connectedInput),
    );
  }

  async capturePullRequestDiff(
    input: Parameters<GitHubReader["capturePullRequestDiff"]>[0],
  ): Promise<Result<void, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.diffs.capturePullRequestDiff(connectedInput),
    );
  }

  async getPullRequestDiff(
    input: {
      readonly profile: WorkspaceProfileConfig;
      readonly pr: PullRequestRef;
    } & PullRequestDiffSource,
  ): Promise<Result<string, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.diffs.getPullRequestDiff(connectedInput),
    );
  }

  async getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.diffs.getFileContents(connectedInput),
    );
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    if (!isConnectedWorkspaceProfile(profile))
      return err({
        _tag: "GitHubAuthenticationFailed",
        operation: "auth_status",
      });

    // The answer is a property of the credential, not of the moment: while the
    // same token is cached, who it authenticates as cannot change. An
    // observation asks three times, and only the first need reach GitHub.
    if (this.credentials.verifiedAccount(profile) === profile.github.account)
      return ok({ host: profile.github.host, account: profile.github.account });
    const response = await this.ghJson(profile, {
      // `gh auth status` exits nonzero if any stale, inactive account is
      // invalid, even when the configured active account can make API calls.
      // Ask GitHub who this invocation can actually authenticate as instead.
      kind: "rest",
      host: profile.github.host,
      path: "user",
    });
    if (response._tag === "err") {
      return err({
        _tag: "GitHubAuthenticationFailed",
        operation: "auth_status",
      });
    }
    const user = v.safeParse(authenticatedUserSchema, response.value);
    if (!user.success || user.output.login !== profile.github.account) {
      return err({
        _tag: "GitHubAuthenticationFailed",
        operation: "auth_status",
      });
    }
    this.credentials.recordVerifiedAccount(profile, profile.github.account);
    return ok({ host: profile.github.host, account: profile.github.account });
  }

  async submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>> {
    if (!isConnectedWorkspaceProfile(input.profile))
      return err({
        _tag: "GitHubWriteFailure",
        category: "auth",
        message: "Workspace has no GitHub connection.",
      });
    const connectedInput = { ...input, profile: input.profile };

    const response = await this.ghJson(connectedInput.profile, {
      kind: "rest",
      host: connectedInput.profile.github.host,
      method: "POST",
      path: `repos/${connectedInput.pr.owner}/${connectedInput.pr.repo}/pulls/${connectedInput.pr.number}/reviews/${connectedInput.reviewId}/events`,
      jsonBody: JSON.stringify({
        event: connectedInput.event,
        body: connectedInput.summaryBody,
      }),
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
    return writeConnectedGitHub(input, (connectedInput) =>
      this.conversation.createDirectSummaryReview(connectedInput),
    );
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
    return readConnectedGitHub(input, (connectedInput) =>
      this.conversation.getViewerDirectSummaryReviews(connectedInput),
    );
  }

  async getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
    readonly reviews?: PullRequestReviewsRead;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>> {
    return readConnectedGitHub(input, (connectedInput) =>
      this.pendingReviews.getViewerPendingReview(connectedInput),
    );
  }

  async startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.pendingReviews.startPendingReviewWithThread(connectedInput),
    );
  }

  async addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.pendingReviews.addPendingReviewThread(connectedInput),
    );
  }

  async discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.pendingReviews.discardPendingReview(connectedInput),
    );
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
        readonly commentNodeId: string;
        readonly reviewId?: string;
        readonly threadId?: string;
      },
      GitHubWriteFailure
    >
  > {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.threadWrites.createInlineComment(connectedInput),
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
    return writeConnectedGitHub(input, (connectedInput) =>
      this.threadWrites.createThreadReply(connectedInput),
    );
  }

  async setReviewThreadState(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly state: "resolved" | "open";
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.threadWrites.setReviewThreadState(connectedInput),
    );
  }

  async addLabelsToLabelable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.collaborators.addLabelsToLabelable(connectedInput),
    );
  }

  async removeLabelsFromLabelable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.collaborators.removeLabelsFromLabelable(connectedInput),
    );
  }

  async addAssigneesToAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.collaborators.addAssigneesToAssignable(connectedInput),
    );
  }

  async removeAssigneesFromAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.collaborators.removeAssigneesFromAssignable(connectedInput),
    );
  }

  async requestReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly userIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.collaborators.requestReviews(connectedInput),
    );
  }

  async removeRequestedReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly logins: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.collaborators.removeRequestedReviewers(connectedInput),
    );
  }

  async setPullRequestDraftState(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly draft: boolean;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.collaborators.setPullRequestDraftState(connectedInput),
    );
  }

  async setPullRequestBaseBranch(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly branch: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.collaborators.setPullRequestBaseBranch(connectedInput),
    );
  }

  async updateThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.threadWrites.updateThreadComment(connectedInput),
    );
  }

  async deleteThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.threadWrites.deleteThreadComment(connectedInput),
    );
  }

  async updateReviewComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.threadWrites.updateReviewComment(connectedInput),
    );
  }

  async deleteReviewComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return writeConnectedGitHub(input, (connectedInput) =>
      this.threadWrites.deleteReviewComment(connectedInput),
    );
  }

  async dismissReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
    readonly message: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    if (!isConnectedWorkspaceProfile(input.profile))
      return err({
        _tag: "GitHubWriteFailure",
        category: "auth",
        message: "Workspace has no GitHub connection.",
      });
    const connectedInput = { ...input, profile: input.profile };

    const response = await this.ghJson(connectedInput.profile, {
      kind: "rest",
      host: connectedInput.profile.github.host,
      method: "PUT",
      path: `repos/${connectedInput.pr.owner}/${connectedInput.pr.repo}/pulls/${connectedInput.pr.number}/reviews/${connectedInput.reviewId}/dismissals`,
      jsonBody: JSON.stringify({ message: connectedInput.message }),
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
    return writeConnectedGitHub(input, (connectedInput) =>
      this.mergePolicy.mergePullRequest(connectedInput),
    );
  }
}

export { FakeGitHubAdapter } from "./fake-github-adapter";
