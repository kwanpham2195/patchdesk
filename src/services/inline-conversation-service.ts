import type { GitHubReader, GitHubReviewWriter } from "../adapters/github/github-adapter";
import type { GitHubReviewCoordinates } from "../domain/patch";
import type { ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { ReviewWriteExpectation, ReviewWriteGate } from "./review-write-gate";
import { err, ok, type Result } from "../domain/result";

export type DirectConversationCommand =
  | {
      readonly _tag: "CreateComment";
      readonly expected: ReviewWriteExpectation;
      readonly anchor: {
        readonly path: string;
        readonly startLine: number;
        readonly line: number;
        readonly side: "new" | "old";
      };
      readonly body: string;
    }
  | {
      readonly _tag: "Reply";
      readonly expected: ReviewWriteExpectation;
      readonly threadId: string;
      readonly body: string;
    }
  | {
      readonly _tag: "SetThreadState";
      readonly expected: ReviewWriteExpectation;
      readonly threadId: string;
      readonly state: "open" | "resolved";
    }
  | {
      readonly _tag: "EditComment";
      readonly expected: ReviewWriteExpectation;
      readonly commentId: string;
      readonly body: string;
    }
  | {
      readonly _tag: "DeleteComment";
      readonly expected: ReviewWriteExpectation;
      readonly commentId: string;
      readonly confirmation: boolean;
    };

export type DirectConversationReceipt =
  | { readonly _tag: "CommentCreated"; readonly commentId: string; readonly threadId?: string; readonly reviewId?: string }
  | { readonly _tag: "ReplyCreated"; readonly commentId: string; readonly reviewId?: string }
  | { readonly _tag: "ThreadStateChanged"; readonly threadId: string; readonly state: "open" | "resolved" }
  | { readonly _tag: "CommentEdited"; readonly commentId: string }
  | { readonly _tag: "CommentDeleted"; readonly commentId: string };

export type DirectConversationFailure =
  | "invalid_input"
  | "not_found"
  | "not_fresh"
  | "permission_denied"
  | "pending_review"
  | "github_read_failed"
  | "github_write_failed"
  | "confirmation_required";

type Gateway = Pick<GitHubReader, "getPullRequest" | "getPullRequestComments"> & Pick<GitHubReviewWriter, "createInlineComment" | "createThreadReply" | "setReviewThreadState" | "updateThreadComment" | "deleteThreadComment">;

/** Owns direct, GitHub-published Diff conversation commands for one fresh Review. */
export class InlineConversationService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireFresh">,
    private readonly github: Gateway,
  ) {}

  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: DirectConversationCommand;
  }): Promise<Result<DirectConversationReceipt, DirectConversationFailure>> {
    if ((input.command._tag === "CreateComment" || input.command._tag === "Reply" || input.command._tag === "EditComment") && input.command.body.trim().length === 0)
      return err("invalid_input");
    if (input.command._tag === "DeleteComment" && !input.command.confirmation)
      return err("confirmation_required");

    const fresh = await this.gate.requireFresh(input.profileId, input.reviewId, input.command.expected);
    if (fresh._tag === "err") return err(fresh.error.reason === "not_fresh" || fresh.error.reason === "stale" ? "not_fresh" : fresh.error.reason === "terminal" ? "permission_denied" : "not_found");
    const pr = {
      host: fresh.value.session.key.host,
      owner: fresh.value.session.key.owner,
      repo: fresh.value.session.key.repo,
      number: fresh.value.session.key.prNumber,
    };
    const current = await this.github.getPullRequest({ profile: fresh.value.profile, pr });
    if (current._tag === "err") return err("github_read_failed");
    if (current.value.headSha !== fresh.value.session.key.headSha) return err("not_fresh");

    switch (input.command._tag) {
      case "CreateComment": {
        if (this.github.createInlineComment === undefined) return err("github_write_failed");
        const coordinates = coordinatesFor(input.command.anchor);
        if (coordinates === undefined) return err("invalid_input");
        const created = await this.github.createInlineComment({ profile: fresh.value.profile, pr, headSha: fresh.value.session.key.headSha, coordinates, body: input.command.body.trim() });
        if (created._tag === "err") {
          return err(created.error.category === "pending_review" ? "pending_review" : "github_write_failed");
        }
        return ok({ _tag: "CommentCreated", commentId: created.value.commentId, ...(created.value.threadId === undefined ? {} : { threadId: created.value.threadId }), ...(created.value.reviewId === undefined ? {} : { reviewId: created.value.reviewId }) });
      }
      case "Reply": {
        if (this.github.createThreadReply === undefined) return err("github_write_failed");
        const created = await this.github.createThreadReply({ profile: fresh.value.profile, threadId: input.command.threadId as never, body: input.command.body.trim() });
        return created._tag === "err" ? err("github_write_failed") : ok({ _tag: "ReplyCreated", commentId: created.value.commentId, ...(created.value.reviewId === undefined ? {} : { reviewId: created.value.reviewId }) });
      }
      case "SetThreadState": {
        if (this.github.setReviewThreadState === undefined) return err("github_write_failed");
        const changed = await this.github.setReviewThreadState({ profile: fresh.value.profile, threadId: input.command.threadId as never, state: input.command.state });
        return changed._tag === "err" ? err("github_write_failed") : ok({ _tag: "ThreadStateChanged", threadId: input.command.threadId, state: input.command.state });
      }
      case "EditComment":
      case "DeleteComment": {
        const authorized = await this.ownedComment(fresh.value.profile, pr, input.command.commentId);
        if (authorized._tag === "err") return authorized;
        if (input.command._tag === "EditComment") {
          if (this.github.updateThreadComment === undefined) return err("github_write_failed");
          const changed = await this.github.updateThreadComment({ profile: fresh.value.profile, commentId: input.command.commentId, body: input.command.body.trim() });
          return changed._tag === "err" ? err("github_write_failed") : ok({ _tag: "CommentEdited", commentId: input.command.commentId });
        }
        if (this.github.deleteThreadComment === undefined) return err("github_write_failed");
        const deleted = await this.github.deleteThreadComment({ profile: fresh.value.profile, commentId: input.command.commentId });
        return deleted._tag === "err" ? err("github_write_failed") : ok({ _tag: "CommentDeleted", commentId: input.command.commentId });
      }
    }
  }

  private async ownedComment(profile: Parameters<Gateway["getPullRequestComments"]>[0]["profile"], pr: Parameters<Gateway["getPullRequestComments"]>[0]["pr"], commentId: string): Promise<Result<void, DirectConversationFailure>> {
    const comments = await this.github.getPullRequestComments({ profile, pr });
    if (comments._tag === "err") return err("github_read_failed");
    const comment = comments.value.threads.flatMap((thread) => thread.comments).find((candidate) => candidate.id === commentId);
    return comment === undefined ? err("not_found") : comment.viewerDidAuthor === true ? ok(undefined) : err("permission_denied");
  }
}

function coordinatesFor(anchor: Extract<DirectConversationCommand, { readonly _tag: "CreateComment" }> ["anchor"]): GitHubReviewCoordinates | undefined {
  if (!Number.isInteger(anchor.startLine) || !Number.isInteger(anchor.line) || anchor.startLine < 1 || anchor.line < anchor.startLine) return undefined;
  const side = anchor.side === "new" ? "RIGHT" : "LEFT";
  return anchor.startLine === anchor.line
    ? { path: anchor.path, line: anchor.line, side }
    : { path: anchor.path, start_line: anchor.startLine, start_side: side, line: anchor.line, side };
}
