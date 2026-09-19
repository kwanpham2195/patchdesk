import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import {
  type GhRequestRunner,
  type GitHubReadFailure,
  type GitHubReadOperation,
} from "./gh-request-runner";
import type { GitHubRequest } from "./github-request";
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
import { invalid } from "./github-write-failures";
import type { GitHubCommentTarget, GitHubThreadTarget } from "./github-adapter";

/**
 * Reads review threads and their comments, and answers whether a thread or a
 * review comment belongs to the pull request in hand.
 */
export class GitHubThreadReader {
  constructor(private readonly requests: GhRequestRunner) {}

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
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
        kind: "graphql",
        host: input.profile.githubHost,
        document: threadQuery,
        variables: [
          { kind: "typed", name: "owner", value: input.pr.owner },
          { kind: "typed", name: "name", value: input.pr.repo },
          { kind: "typed", name: "number", value: input.pr.number },
          ...(cursor === undefined
            ? []
            : [{ kind: "typed" as const, name: "cursor", value: cursor }]),
        ],
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
        kind: "graphql",
        host: profile.githubHost,
        document: threadCommentsQuery,
        variables: [
          { kind: "typed", name: "id", value: threadId },
          { kind: "typed", name: "cursor", value: cursor },
        ],
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

  /**
   * What a failed node lookup means. Only GitHub answering NOT_FOUND is
   * evidence that the node does not exist; a forbidden, rate-limited,
   * unavailable, timed-out, or unauthenticated read means the membership is
   * unknown, and reporting that as "not a member" would hand a caller absence
   * it never established (ADR 0024, ADR 0035).
   */
  private lookupFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<{ readonly found: false }, GitHubReadFailure> {
    return failure._tag === "CommandNotFound"
      ? ok({ found: false })
      : this.commandFailure(operation, failure, host);
  }

  async getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host: input.profile.githubHost,
      document: reviewThreadTargetQuery,
      variables: [{ kind: "typed", name: "id", value: input.threadId }],
    });
    if (response._tag === "err") {
      return this.lookupFailure(
        "get_thread_target",
        response.error,
        input.profile.githubHost,
      );
    }
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
      kind: "graphql",
      host: input.profile.githubHost,
      document: reviewCommentTargetQuery,
      variables: [{ kind: "typed", name: "id", value: input.commentId }],
    });
    if (response._tag === "err") {
      return this.lookupFailure(
        "get_comment_target",
        response.error,
        input.profile.githubHost,
      );
    }
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
