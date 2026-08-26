import type {
  AssignableUserListing,
  CheckSummary,
  Conversation,
  GitHubComments,
  GitHubMergePolicyEvidence,
  GitHubPublishedFeedback,
  MergePolicySnapshot,
  MaintainerPullRequestPage,
  MaintainerPullRequestSearchPage,
  PullRequestCommit,
  PullRequestReviewerListing,
  PullRequestSummary,
  RepositoryLabelListing,
} from "../../domain/github-context";
import {
  type GitSha,
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
} from "../../domain/pending-review";
import type { GitHubReviewEvent } from "../../domain/pending-review";
import type { GitHubWriteFailure } from "../../domain/github-write";
import type { GitHubReviewCoordinates } from "../../domain/patch";
import {
  type AuthenticatedGitHubAccount,
  type BranchProtectionEvidence,
  type FetchedDiffRefs,
  type GitHubCommentTarget,
  type GitHubFileContents,
  type GitHubMergeWriter,
  type GitHubReader,
  type GitHubReadFailure,
  type GitHubReviewWriter,
  type GitHubThreadTarget,
  type MergeOutcome,
  type PendingReviewComment,
  type RepositoryPermissionEvidence,
} from "./github-adapter";
import { samePullRequest } from "./github-wire-projections";
import { missing } from "./github-write-failures";

/** A fixture-oriented GitHubReader with no process, filesystem, or network behavior. */
export class FakeGitHubAdapter
  implements GitHubReader, GitHubReviewWriter, GitHubMergeWriter
{
  constructor(private readonly values: Partial<FakeGitHubAdapterValues>) {}

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    void input;
    return this.values.listOpenPullRequests === undefined
      ? missing("list_open_prs")
      : ok(this.values.listOpenPullRequests);
  }

  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly scope?: InboxScope;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestPage, GitHubReadFailure>> {
    void input;
    if (this.values.maintainerPullRequests !== undefined)
      return ok(this.values.maintainerPullRequests);
    if (this.values.listOpenPullRequests === undefined)
      return missing("list_maintainer_prs");
    return ok({
      entries: this.values.listOpenPullRequests.map((summary, index) => ({
        cursor: `fixture-${index}`,
        pullRequest: {
          summary,
          checks: this.values.checks ?? { overall: "unknown", checks: [] },
        },
      })),
      hasNextPage: false,
    });
  }

  async searchMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly searchQuery: string;
    readonly scope: InboxScope;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestSearchPage, GitHubReadFailure>> {
    void input;
    if (this.values.maintainerPullRequestsSearch !== undefined)
      return ok(this.values.maintainerPullRequestsSearch);
    if (this.values.listOpenPullRequests === undefined)
      return missing("search_maintainer_prs");
    // Fallback fixture built off `listOpenPullRequests`: issueCount equals
    // the entry count here, unlike `maintainerPullRequestsSearch`, which a
    // test sets explicitly to prove the two can differ.
    return ok({
      entries: this.values.listOpenPullRequests.map((summary, index) => ({
        cursor: `fixture-${index}`,
        pullRequest: {
          summary,
          checks: this.values.checks ?? { overall: "unknown", checks: [] },
        },
      })),
      hasNextPage: false,
      issueCount: this.values.listOpenPullRequests.length,
    });
  }

  async listRepositoryLabels(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<RepositoryLabelListing, GitHubReadFailure>> {
    void input;
    return this.values.repositoryLabels === undefined
      ? missing("list_repository_labels")
      : ok(this.values.repositoryLabels);
  }

  async listAssignableUsers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
    readonly query?: string;
  }): Promise<Result<AssignableUserListing, GitHubReadFailure>> {
    void input;
    return this.values.assignableUsers === undefined
      ? missing("list_assignable_users")
      : ok(this.values.assignableUsers);
  }

  async getPullRequestReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestReviewerListing, GitHubReadFailure>> {
    void input;
    return this.values.pullRequestReviewers === undefined
      ? missing("get_pull_request_reviewers")
      : ok(this.values.pullRequestReviewers);
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    void input;
    return this.values.pullRequest === undefined
      ? missing("get_pr")
      : ok(this.values.pullRequest);
  }

  async getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>> {
    if (this.values.mergePolicy !== undefined)
      return ok(this.values.mergePolicy);
    const current = await this.getPullRequest(input);
    if (current._tag === "err") return current;
    let policy: MergePolicySnapshot = {
      pr: input.pr,
      headSha: current.value.headSha,
      isOpen: current.value.isOpen,
      isDraft: current.value.isDraft,
      mergeability: current.value.mergeability,
      reviewDecision:
        current.value.reviewState === "approved"
          ? "approved"
          : current.value.reviewState === "changes_requested"
            ? "changes_requested"
            : current.value.reviewState === "review_pending"
              ? "review_required"
              : "unknown",
      checks: this.values.checks ?? { overall: "unknown", checks: [] },
      complete:
        current.value.headSha === input.expectedHeadSha &&
        current.value.baseSha !== undefined &&
        current.value.reviewState !== "none" &&
        current.value.reviewState !== "unknown" &&
        this.values.checks !== undefined,
    };
    if (current.value.baseSha !== undefined)
      policy = { ...policy, baseSha: current.value.baseSha };
    if (current.value.headSha !== input.expectedHeadSha)
      policy = { ...policy, incompleteReason: "head_mismatch" };
    return ok(policy);
  }

  async getMergePolicyEvidence(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>> {
    void input;
    return this.values.mergePolicyEvidence === undefined
      ? missing("get_merge_policy_evidence")
      : ok(this.values.mergePolicyEvidence);
  }

  async getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>> {
    void input;
    return this.values.mergeOutcome === undefined
      ? missing("get_pr")
      : ok(this.values.mergeOutcome);
  }

  async getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>> {
    void input;
    return ok(this.values.commits ?? []);
  }

  async getPullRequestPublishedFeedback(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>> {
    void input;
    return this.values.publishedFeedback === undefined
      ? ok({ reviews: [], comments: [], complete: true })
      : ok(this.values.publishedFeedback);
  }

  async getRepositoryPermission(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: string;
  }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>> {
    void input;
    return this.values.repositoryPermission === undefined
      ? missing("get_repository_permission")
      : ok(this.values.repositoryPermission);
  }

  async getBranchProtection(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>> {
    void input;
    return this.values.branchProtection === undefined
      ? missing("get_branch_protection")
      : ok(this.values.branchProtection);
  }

  async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    void input;
    return this.values.comments === undefined
      ? missing("get_comments")
      : ok(this.values.comments);
  }

  async getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>> {
    if (this.values.threadTargets === undefined)
      return missing("get_thread_target");
    const target = this.values.threadTargets.find(
      (entry) =>
        entry.threadId === input.threadId &&
        samePullRequest(entry.pr, input.pr),
    );
    if (target === undefined) return ok({ found: false });
    return ok({ found: true });
  }

  async getReviewCommentTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>> {
    if (this.values.commentTargets === undefined)
      return missing("get_comment_target");
    const target = this.values.commentTargets.find(
      (entry) =>
        entry.commentId === input.commentId &&
        samePullRequest(entry.pr, input.pr),
    );
    return target === undefined
      ? ok({ found: false })
      : ok({ found: true, viewerDidAuthor: target.viewerDidAuthor });
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    void input;
    return this.values.checks === undefined
      ? missing("get_checks")
      : ok(this.values.checks);
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
    void input;
    return this.values.createInlineComment === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "create_inline_comment",
        })
      : ok(this.values.createInlineComment);
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
    void input;
    return this.values.createThreadReply === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "create_thread_reply",
        })
      : ok(this.values.createThreadReply);
  }

  async setReviewThreadState(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly state: "resolved" | "open";
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.setReviewThreadState === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "set_thread_state",
        })
      : ok(undefined);
  }

  async addAssigneesToAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.addAssigneesToAssignable === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "add_assignees",
        })
      : ok(undefined);
  }

  async removeAssigneesFromAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.removeAssigneesFromAssignable === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "remove_assignees",
        })
      : ok(undefined);
  }

  async requestReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly userIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.requestReviews === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "request_reviews",
        })
      : ok(undefined);
  }

  async removeRequestedReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly logins: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.removeRequestedReviewers === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "remove_requested_reviewers",
        })
      : ok(undefined);
  }

  async updateThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.updateThreadComment === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "update_comment",
        })
      : ok(undefined);
  }

  async deleteThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.deleteThreadComment === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "delete_comment",
        })
      : ok(undefined);
  }

  async getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>> {
    void input;
    return this.values.diff === undefined
      ? missing("get_diff")
      : ok(this.values.diff);
  }

  async getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>> {
    void input;
    return this.values.fileContents === undefined
      ? missing("get_file")
      : ok(this.values.fileContents);
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    void profile;
    return this.values.authenticatedAccount === undefined
      ? missing("auth_status")
      : ok(this.values.authenticatedAccount);
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
    void input;
    return this.values.pendingReview === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "Missing pending review fixture.",
        })
      : ok(this.values.pendingReview);
  }

  async submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>> {
    void input;
    return this.values.pendingReviewSubmission === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "Missing submitted review fixture.",
        })
      : ok(this.values.pendingReviewSubmission);
  }

  async getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>> {
    void input;
    const value = this.values.viewerPendingReview;
    if (value === undefined) return missing("get_pending_review");
    // Import isolation: a foreign account never sees the viewer's pending review.
    return value.account === input.account
      ? ok(value.read)
      : ok({ _tag: "None" });
  }

  async startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    void input;
    const value = this.values.pendingReviewStart;
    if (value === undefined) {
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "Missing pending-review start fixture.",
      });
    }
    return value.failure === undefined ? ok(value.write) : err(value.failure);
  }

  async addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    void input;
    const value = this.values.pendingReviewAddThread;
    if (value === undefined) {
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "Missing pending-review append fixture.",
      });
    }
    return value.failure === undefined ? ok(value.write) : err(value.failure);
  }

  async discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    const value = this.values.pendingReviewDiscard;
    if (value === undefined) {
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "Missing pending-review discard fixture.",
      });
    }
    return value.failure === undefined ? ok(undefined) : err(value.failure);
  }

  async mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<
    Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>
  > {
    void input;
    return this.values.mergeResult === undefined
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "Missing merge fixture.",
        })
      : ok(this.values.mergeResult);
  }

  async loadConversation(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<Conversation, GitHubReadFailure>> {
    void input;
    const pr = this.values.pullRequest;
    const prDescription = pr?.description ?? "";
    const threads = this.values.comments ?? { threads: [], complete: true };
    const feedback: GitHubPublishedFeedback = this.values.publishedFeedback ?? {
      reviews: [],
      comments: [],
    };
    const entries: Conversation["entries"][number][] = [];
    for (const review of feedback.reviews) {
      entries.push({ _tag: "ReviewSummary" as const, review });
    }
    for (const comment of feedback.comments) {
      entries.push({ _tag: "IssueComment" as const, comment });
    }
    for (const thread of threads.threads) {
      if (thread.location !== undefined) continue;
      entries.push({ _tag: "GeneralThread" as const, thread });
    }
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
    return ok({
      prDescription,
      entries,
      complete: feedback.complete !== false && threads.complete !== false,
    });
  }
}

/** Fixture values accepted by FakeGitHubAdapter. */
export type FakeGitHubAdapterValues = {
  readonly listOpenPullRequests: ReadonlyArray<PullRequestSummary>;
  readonly maintainerPullRequests: MaintainerPullRequestPage;
  /** `searchMaintainerPullRequests` fixture. Set `issueCount` independently of `entries.length` to test the repository-wide count diverging from the loaded page. */
  readonly maintainerPullRequestsSearch: MaintainerPullRequestSearchPage;
  readonly repositoryLabels: RepositoryLabelListing;
  readonly assignableUsers: AssignableUserListing;
  readonly pullRequestReviewers: PullRequestReviewerListing;
  readonly pullRequest: PullRequestSummary;
  readonly mergePolicy: MergePolicySnapshot;
  readonly mergePolicyEvidence: GitHubMergePolicyEvidence;
  readonly mergeOutcome: MergeOutcome;
  readonly comments: GitHubComments;
  readonly publishedFeedback: GitHubPublishedFeedback;
  readonly repositoryPermission: RepositoryPermissionEvidence;
  readonly branchProtection: BranchProtectionEvidence;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly checks: CheckSummary;
  readonly diff: string;
  readonly fileContents: GitHubFileContents;
  readonly authenticatedAccount: AuthenticatedGitHubAccount;
  readonly pendingReview: {
    readonly reviewId: string;
    readonly state: "PENDING";
  };
  readonly pendingReviewSubmission: { readonly reviewId: string };
  /** Spike-proven pending-review gateway fixtures; an absent reader is unimplemented. */
  readonly viewerPendingReview?: {
    readonly account: GitHubLogin;
    readonly read: PendingReviewRead;
  };
  readonly pendingReviewStart?: {
    readonly write: PendingReviewThreadWrite;
    readonly failure?: GitHubWriteFailure;
  };
  readonly pendingReviewAddThread?: {
    readonly write: PendingReviewThreadWrite;
    readonly failure?: GitHubWriteFailure;
  };
  readonly pendingReviewDiscard?: { readonly failure?: GitHubWriteFailure };
  readonly mergeResult: { readonly mergeCommitSha?: GitSha };
  /** Thread ids proven to belong to the fixture pull request (owner/repo/number). */
  readonly threadTargets: ReadonlyArray<{
    readonly threadId: GitHubThreadId;
    readonly pr: PullRequestRef;
  }>;
  /** Comment ids proven to belong to the fixture pull request, with authorship. */
  readonly commentTargets: ReadonlyArray<{
    readonly commentId: string;
    readonly viewerDidAuthor: boolean;
    readonly pr: PullRequestRef;
  }>;
  /** Confirmed writer receipts; an absent writer keeps the fake unimplemented. */
  readonly createInlineComment?: {
    readonly commentId: string;
    readonly reviewId?: string;
    readonly threadId?: string;
  };
  readonly createThreadReply?: {
    readonly commentId: string;
    readonly reviewId?: string;
  };
  readonly setReviewThreadState?: Record<string, never>;
  readonly updateThreadComment?: Record<string, never>;
  readonly deleteThreadComment?: Record<string, never>;
  readonly addAssigneesToAssignable?: Record<string, never>;
  readonly removeAssigneesFromAssignable?: Record<string, never>;
  readonly requestReviews?: Record<string, never>;
  readonly removeRequestedReviewers?: Record<string, never>;
};
