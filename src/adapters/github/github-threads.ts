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
  GitHubComment,
  GitHubComments,
  GitHubConversationThread,
} from "../../domain/github-context";
import { type GitHubThreadId, parseGitHubThreadId } from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import {
  maxReviewCommentPages,
  maxReviewComments,
  maxReviewThreadPages,
  maxReviewThreads,
  reviewCommentTargetQuery,
  reviewThreadTargetQuery,
  threadCommentsQuery,
  threadQuery,
} from "./github-graphql-queries";
import {
  reviewCommentTargetSchema,
  reviewThreadTargetSchema,
  threadCommentsResponseSchema,
  threadResponseSchema,
} from "./github-wire-schemas";
import {
  matchesPullRequest,
  parseComment,
  parseLocation,
} from "./github-wire-projections";
import { invalid, missing } from "./github-write-failures";
import type { GitHubCommentTarget, GitHubThreadTarget } from "./github-adapter";

/**
 * Reads review threads and their comments, and answers whether a thread or a
 * review comment belongs to the pull request in hand.
 */
export class GitHubThreadReader {
  constructor(private readonly requests: GhRequestRunner) {}

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
}
