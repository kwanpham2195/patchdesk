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
  PendingReviewComment,
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
  PendingReviewComment,
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

  async setPullRequestDraftState(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly draft: boolean;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.collaborators.setPullRequestDraftState(input);
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
