import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import { type GhRequestRunner } from "./gh-request-runner";
import type { GitHubRequest } from "./github-request";
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
  nullMutationNodeSchema,
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

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
  }

  /**
   * Confirms a REST-created comment's published thread with up to three reads
   * of the 20 newest threads, waiting 500 then 1500 ms between attempts for
   * eventual consistency. Match the REST `node_id` to the GraphQL comment ID
   * and check the body. A transport or command error stops retries; return
   * `undefined` without a confirmed thread ID. This optional read-back must
   * not turn the already successful comment write into a failure.
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
        kind: "graphql",
        host: profile.githubHost,
        document: confirmCreatedCommentThreadQuery,
        variables: [
          { kind: "typed", name: "owner", value: pr.owner },
          { kind: "typed", name: "name", value: pr.repo },
          { kind: "typed", name: "number", value: pr.number },
        ],
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
        /** The same comment's GraphQL node id, the only id space every projected thread comment uses. */
        readonly commentNodeId: string;
        readonly reviewId?: string;
        readonly threadId?: string;
      },
      GitHubWriteFailure
    >
  > {
    const response = await this.ghJson(input.profile, {
      kind: "rest",
      host: input.profile.githubHost,
      method: "POST",
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/comments`,
      jsonBody: JSON.stringify({
        body: input.body,
        commit_id: input.headSha,
        ...input.coordinates,
      }),
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
      commentNodeId: created.output.node_id,
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
      kind: "graphql",
      host: input.profile.githubHost,
      document: addThreadReplyMutation,
      variables: [
        { kind: "typed", name: "threadId", value: input.threadId },
        { kind: "string", name: "body", value: input.body },
      ],
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const replied = v.safeParse(addedThreadReplySchema, response.value);
    const comment = replied.success
      ? replied.output.data.addPullRequestReviewThreadReply.comment
      : undefined;
    if (comment === null)
      return err(writeFailure({ _tag: "CommandUnprocessable" }));
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
      kind: "graphql",
      host: input.profile.githubHost,
      document: reviewThreadStateMutation(input.state),
      variables: [{ kind: "typed", name: "threadId", value: input.threadId }],
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    return v.is(nullMutationNodeSchema("thread"), response.value)
      ? err(writeFailure({ _tag: "CommandUnprocessable" }))
      : ok(undefined);
  }

  async updateThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host: input.profile.githubHost,
      document: updateThreadCommentMutation,
      variables: [
        { kind: "typed", name: "commentId", value: input.commentId },
        { kind: "string", name: "body", value: input.body },
      ],
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    return v.is(
      nullMutationNodeSchema("pullRequestReviewComment"),
      response.value,
    )
      ? err(writeFailure({ _tag: "CommandUnprocessable" }))
      : ok(undefined);
  }

  async deleteThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host: input.profile.githubHost,
      document: deleteThreadCommentMutation,
      variables: [{ kind: "typed", name: "commentId", value: input.commentId }],
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
      kind: "rest",
      host: input.profile.githubHost,
      method: "PATCH",
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/comments/${input.commentId}`,
      jsonBody: JSON.stringify({ body: input.body }),
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
      kind: "rest",
      host: input.profile.githubHost,
      method: "DELETE",
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/comments/${input.commentId}`,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }
}
