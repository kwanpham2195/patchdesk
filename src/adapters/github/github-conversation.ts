import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import {
  commandTimeoutMs,
  type GhCommandRequest,
  type GhRequestRunner,
  type GitHubReadFailure,
  type GitHubReadOperation,
} from "./gh-request-runner";
import type {
  Conversation,
  GitHubComments,
  GitHubPublishedFeedback,
  PublishedReview,
  PublishedReviewComment,
  PullRequestSummary,
} from "../../domain/github-context";
import {
  type GitHubLogin,
  type GitSha,
  parseGitHubReviewRestId,
  parseGitSha,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type { GitHubReviewEvent } from "../../domain/pending-review";
import type { DirectSummaryReviewReceipt } from "../../domain/direct-summary-review";
import type { GitHubWriteFailure } from "../../domain/github-write";
import {
  directSummaryReceiptSchema,
  publishedCommentSchema,
  publishedReviewSchema,
} from "./github-wire-schemas";
import {
  assembleConversationEntries,
  digestReviewBody,
  directSummaryEvent,
  parseDirectSummaryReceipt,
  parseGitHubTimestamp,
  parseLocation,
} from "./github-wire-projections";
import { directSummaryWriteFailure, invalid } from "./github-write-failures";
import type {
  AuthenticatedGitHubAccount,
  BranchProtectionEvidence,
  DirectSummaryPublishedReview,
  RepositoryPermissionEvidence,
} from "./github-adapter";
import type { GitHubPullRequestReader } from "./github-pull-request-reader";
import type { GitHubThreadReader } from "./github-threads";
import type { GitHubMergePolicyReader } from "./github-merge-policy";

/**
 * The one account read this module needs from the adapter: which GitHub
 * account gh is authenticated as. `getPullRequestPublishedFeedback` asks so it
 * can decide whether the viewer's own repository permission is worth reading.
 */
type AuthenticatedAccountReader = {
  resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>>;
};

/**
 * Assembles the pull request conversation: published feedback, the direct
 * summary reviews the viewer owns, and the merged chronological transcript.
 */
export class GitHubConversationReader {
  constructor(
    private readonly requests: GhRequestRunner,
    private readonly pullRequests: GitHubPullRequestReader,
    private readonly threads: GitHubThreadReader,
    private readonly mergePolicy: GitHubMergePolicyReader,
    private readonly accounts: AuthenticatedAccountReader,
  ) {}

  /** Run a gh command that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
  }

  private commandFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<never, GitHubReadFailure> {
    return this.requests.commandFailure(operation, failure, host);
  }

  private async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    return this.pullRequests.getPullRequest(input);
  }

  private async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    return this.threads.getPullRequestComments(input);
  }

  private async getRepositoryPermission(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: string;
  }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>> {
    return this.mergePolicy.getRepositoryPermission(input);
  }

  private async getBranchProtection(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>> {
    return this.mergePolicy.getBranchProtection(input);
  }

  private async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    return this.accounts.resolveAuthenticatedAccount(profile);
  }

  async getPullRequestPublishedFeedback(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>> {
    const [reviews, comments, account, pullRequest] = await Promise.all([
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
      // The base branch this read needs for branch protection. It was already
      // fetched unconditionally, so joining the batch costs nothing and drops
      // one sequential round trip from every Conversation load. The gh call
      // order is now reviews, comments, `auth status`, pull request, then the
      // sequential permission and branch-protection reads — the positional
      // fixtures in `tests/adapters/github-adapter.test.ts` are in that order.
      this.getPullRequest({ profile: input.profile, pr: input.pr }),
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

  /**
   * Splits one loaded pull request into its two conversation halves: the
   * timeline `assembleConversationEntries` orders, and the anchored threads
   * the diff places (ADR 0028).
   */
  private assembleConversation(
    prDescription: string,
    feedback: GitHubPublishedFeedback,
    comments: GitHubComments,
  ): Conversation {
    let inline: GitHubComments = {
      threads: comments.threads.filter(
        (thread) => thread.location !== undefined,
      ),
    };
    if (comments.complete !== undefined)
      inline = { ...inline, complete: comments.complete };
    if (comments.incompleteReason !== undefined)
      inline = { ...inline, incompleteReason: comments.incompleteReason };
    return {
      prDescription,
      entries: assembleConversationEntries(feedback, comments),
      inline,
      complete: feedback.complete !== false && comments.complete !== false,
    };
  }
}
