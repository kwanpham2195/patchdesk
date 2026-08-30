import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import {
  commandTimeoutMs,
  type GhCommandRequest,
  type GhRequestRunner,
} from "./gh-request-runner";
import {
  type GitHubThreadId,
  type GitSha,
  parseGitHubThreadId,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type { GitHubWriteFailure } from "../../domain/github-write";
import type { GitHubReviewCoordinates } from "../../domain/patch";
import {
  addThreadReplyMutation,
  confirmCreatedCommentThreadQuery,
  deleteThreadCommentMutation,
  reviewThreadStateMutation,
  updateThreadCommentMutation,
} from "./github-graphql-queries";
import {
  addedThreadReplySchema,
  createdInlineCommentSchema,
  threadResponseSchema,
} from "./github-wire-schemas";
import { writeFailure } from "./github-write-failures";

/** Backoff delay for `confirmPublishedCommentThread`'s retried read-back. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes review threads and their comments: new inline threads, replies,
 * resolve/unresolve, and edits or deletions of a single comment.
 */
export class GitHubThreadWriter {
  constructor(private readonly requests: GhRequestRunner) {}

  /** Run a gh command that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
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
    const receipt = {
      commentId:
        created.output.id === undefined
          ? created.output.node_id
          : String(created.output.id),
    };
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
        `query=${addThreadReplyMutation}`,
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
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${reviewThreadStateMutation(input.state)}`,
        "-F",
        `threadId=${input.threadId}`,
      ],
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
        `query=${updateThreadCommentMutation}`,
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
        `query=${deleteThreadCommentMutation}`,
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
    const response = await this.requests.ghText(input.profile, {
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
}
