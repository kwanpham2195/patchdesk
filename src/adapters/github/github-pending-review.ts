import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import {
  type GhRequestRunner,
  type GitHubReadFailure,
  type GitHubReadOperation,
} from "./gh-request-runner";
import type { GitHubRequest } from "./github-request";
import {
  type GitHubLogin,
  type GitHubReviewNodeId,
  type GitHubReviewRestId,
  type GitSha,
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  parseGitSha,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import {
  samePendingReviewAnchor,
  type PendingReviewAnchor,
  type PendingReviewRead,
  type PendingReviewThreadWrite,
  type ViewerPendingReview,
} from "../../domain/pending-review";
import type { GitHubWriteFailure } from "../../domain/github-write";
import {
  addPendingReviewThreadMutation,
  pendingReviewThreadsQuery,
} from "./github-graphql-queries";
import {
  addedReviewThreadSchema,
  pendingReviewThreadsResponseSchema,
  reviewReceiptSchema,
  writtenNodeSchema,
} from "./github-wire-schemas";
import {
  classifyPullRequestReviews,
  type PullRequestReviewsRead,
} from "./github-pull-request-reviews";
import {
  parseGitHubTimestamp,
  parsePendingReview,
  parseReviewId,
  pendingReviewAnchor,
  pendingReviewComment,
} from "./github-wire-projections";
import { invalid, writeFailure } from "./github-write-failures";

/**
 * Owns the viewer's pending (unsubmitted) review: reading it back, starting
 * one with its first thread, adding later threads, and discarding it.
 */
export class GitHubPendingReviews {
  constructor(private readonly requests: GhRequestRunner) {}

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
  }

  /** Run a request that returns text as the profile's configured GitHub account. */
  private async ghText(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<string, CommandFailure>> {
    return this.requests.ghText(profile, request);
  }

  private commandFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<never, GitHubReadFailure> {
    return this.requests.commandFailure(operation, failure, host);
  }

  /** This reader's own review-list read, on the default media type a write-safety read has always used. */
  private async readReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<PullRequestReviewsRead> {
    return classifyPullRequestReviews(
      await this.ghJson(input.profile, {
        kind: "rest",
        host: input.profile.githubHost,
        path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews?per_page=100&page=1`,
      }),
    );
  }

  async getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
    /** The pull request's review list, when the caller already read it; otherwise this reader reads it. */
    readonly reviews?: PullRequestReviewsRead;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>> {
    const reviews = input.reviews ?? (await this.readReviews(input));
    if (reviews._tag === "Unreadable")
      return this.commandFailure(
        "get_pending_review",
        reviews.failure,
        input.profile.githubHost,
      );
    if (reviews._tag === "Unparsable") return invalid("get_pending_review");
    const pending = reviews.reviews.filter(
      (review) =>
        review.state === "PENDING" && review.user?.login === input.account,
    );
    if (pending.length === 0) {
      // None is provable only with a complete bounded result; an incomplete
      // page is Unavailable, never proof that no pending review exists.
      return reviews.reviews.length < 100
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
      kind: "graphql",
      host: input.profile.githubHost,
      document: pendingReviewThreadsQuery,
      variables: [
        { kind: "typed", name: "owner", value: input.pr.owner },
        { kind: "typed", name: "name", value: input.pr.repo },
        { kind: "typed", name: "number", value: input.pr.number },
      ],
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
      kind: "rest",
      host: input.profile.githubHost,
      method: "POST",
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews`,
      jsonBody: JSON.stringify({
        commit_id: input.headSha,
        comments: [pendingReviewComment(input.anchor, input.body)],
      }),
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
    // The range rides along only when the anchor spans more than one line,
    // which is the rule `pendingReviewComment` applies on the REST start path.
    const startLine =
      input.anchor.startLine === input.anchor.line
        ? undefined
        : input.anchor.startLine;
    const appendQuery = addPendingReviewThreadMutation(side, startLine);
    const appended = await this.ghJson(input.profile, {
      kind: "graphql",
      host: input.profile.githubHost,
      document: appendQuery,
      variables: [
        { kind: "typed", name: "reviewId", value: input.reviewId },
        { kind: "typed", name: "path", value: input.anchor.path },
        { kind: "typed", name: "line", value: input.anchor.line },
        ...(startLine === undefined
          ? []
          : [{ kind: "typed" as const, name: "startLine", value: startLine }]),
        { kind: "string", name: "body", value: input.body },
      ],
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
      anchor: input.anchor,
      body: input.body,
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
    // The read-back owns the comment the write produced: a thread whose body
    // or anchor is not the one this write asked for is unreconciled remote
    // state, never a confirmed write.
    if (createdThread !== undefined) {
      const confirmed = read.value.review.comments.filter(
        (comment) => comment.threadId === createdThread,
      );
      const confirmsWrite =
        expectedAnchor === undefined || expectedBody === undefined
          ? confirmed.length > 0
          : confirmed.some(
              (comment) =>
                comment.body === expectedBody &&
                samePendingReviewAnchor(comment.anchor, expectedAnchor),
            );
      if (confirmsWrite)
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
      kind: "rest",
      host: input.profile.githubHost,
      method: "DELETE",
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews/${input.reviewId}`,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    return ok(undefined);
  }
}
