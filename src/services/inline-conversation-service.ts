import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type { GitHubReviewCoordinates } from "../domain/patch";
import {
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubThreadId,
  parseRepoRelativePath,
  type IsoTimestamp,
  type ReviewId,
  type WorkspaceProfileId,
} from "../domain/ids";
import {
  requireCurrentHead,
  type ReviewWriteExpectation,
  type ReviewWriteGate,
} from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import type { GitHubWriteFailure } from "../domain/github-write";
import {
  confirmReviewWrite,
  markReviewWriteOutcomeUnknown,
  type ReviewWriteIntent,
  type ReviewWriteOperation,
} from "../domain/review-write-operation";
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
  | {
      readonly _tag: "CommentCreated";
      readonly commentId: string;
      readonly reviewId?: string;
      readonly threadId?: string;
    }
  | {
      readonly _tag: "ReplyCreated";
      readonly commentId: string;
      readonly reviewId?: string;
    }
  | {
      readonly _tag: "ThreadStateChanged";
      readonly threadId: string;
      readonly state: "open" | "resolved";
    }
  | { readonly _tag: "CommentEdited"; readonly commentId: string }
  | { readonly _tag: "CommentDeleted"; readonly commentId: string };

export type DirectConversationFailure =
  | "invalid_input"
  | "not_found"
  | "not_fresh"
  | "permission_denied"
  | "forbidden"
  | "pending_review"
  | "github_read_failed"
  | "github_write_failed"
  | "outcome_unknown"
  | "rate_limited"
  | "review_write_in_progress"
  | "confirmation_required";

type Gateway = Pick<
  GitHubReader,
  "getPullRequest" | "getReviewThreadTarget" | "getReviewCommentTarget"
> &
  Pick<
    GitHubReviewWriter,
    | "createInlineComment"
    | "createThreadReply"
    | "setReviewThreadState"
    | "updateThreadComment"
    | "deleteThreadComment"
  >;

/** Owns direct, GitHub-published Diff conversation commands for one fresh Review. */
export class InlineConversationService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireFresh">,
    private readonly github: Gateway,
    private readonly writeCoordinator: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp,
    private readonly recentWrites: Pick<RecentWriteJournalStore, "append">,
    private readonly operations: Pick<
      ReviewWriteOperationStore,
      "load" | "begin" | "markOutcomeUnknown" | "confirm" | "reject" | "remove"
    >,
  ) {}

  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: DirectConversationCommand;
  }): Promise<Result<DirectConversationReceipt, DirectConversationFailure>> {
    const localValidation = validateLocalCommand(input.command);
    if (localValidation._tag === "err") return localValidation;
    const key = `${input.profileId}:${input.reviewId}`;
    if (!this.writeCoordinator.acquire(key))
      return err("review_write_in_progress");
    try {
      const active = await this.operations.load(
        input.profileId,
        input.reviewId,
      );
      if (active._tag === "err" || active.value !== undefined)
        return err("outcome_unknown");
      return await this.executeUnlocked(input);
    } finally {
      this.writeCoordinator.release(key);
    }
  }

  private async executeUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: DirectConversationCommand;
  }): Promise<Result<DirectConversationReceipt, DirectConversationFailure>> {
    if (
      (input.command._tag === "CreateComment" ||
        input.command._tag === "Reply" ||
        input.command._tag === "EditComment") &&
      input.command.body.trim().length === 0
    )
      return err("invalid_input");
    if (input.command._tag === "DeleteComment" && !input.command.confirmation)
      return err("confirmation_required");

    const fresh = await this.gate.requireFresh(
      input.profileId,
      input.reviewId,
      input.command.expected,
    );
    if (fresh._tag === "err")
      return err(
        fresh.error.reason === "not_fresh" || fresh.error.reason === "stale"
          ? "not_fresh"
          : fresh.error.reason === "terminal"
            ? "permission_denied"
            : "not_found",
      );
    const pr = {
      host: fresh.value.session.key.host,
      owner: fresh.value.session.key.owner,
      repo: fresh.value.session.key.repo,
      number: fresh.value.session.key.prNumber,
    };
    const current = await requireCurrentHead(
      this.github,
      fresh.value.profile,
      fresh.value.session,
    );
    if (current._tag === "err")
      return err(
        current.error.reason === "github_read"
          ? "github_read_failed"
          : "not_fresh",
      );

    switch (input.command._tag) {
      case "CreateComment": {
        const command = input.command;
        const actor = parseGitHubLogin(fresh.value.profile.ghAccount);
        const path = parseRepoRelativePath(command.anchor.path);
        if (actor._tag === "err" || path._tag === "err")
          return err("invalid_input");
        const createInlineComment = this.github.createInlineComment?.bind(
          this.github,
        );
        if (createInlineComment === undefined)
          return err("github_write_failed");
        const coordinates = coordinatesFor(command.anchor);
        if (coordinates === undefined) return err("invalid_input");
        return this.runDurableWrite(
          input,
          {
            _tag: "CreateComment",
            expected: command.expected,
            actor: actor.value,
            anchor: { ...command.anchor, path: path.value },
            body: command.body.trim(),
          },
          () =>
            createInlineComment({
              profile: fresh.value.profile,
              pr,
              headSha: fresh.value.session.key.headSha,
              coordinates,
              body: command.body.trim(),
            }),
          (created) => {
            const receipt = {
              _tag: "CommentCreated" as const,
              commentId: created.commentId,
            };
            const withReviewId =
              created.reviewId === undefined
                ? receipt
                : { ...receipt, reviewId: created.reviewId };
            return created.threadId === undefined
              ? withReviewId
              : { ...withReviewId, threadId: created.threadId };
          },
        );
      }
      case "Reply": {
        const command = input.command;
        const actor = parseGitHubLogin(fresh.value.profile.ghAccount);
        if (actor._tag === "err") return err("invalid_input");
        const createThreadReply = this.github.createThreadReply?.bind(
          this.github,
        );
        if (createThreadReply === undefined) return err("github_write_failed");
        const threadId = parseGitHubThreadId(command.threadId);
        if (threadId._tag === "err") return err("not_found");
        const target = await this.github.getReviewThreadTarget({
          profile: fresh.value.profile,
          pr,
          threadId: threadId.value,
        });
        if (target._tag === "err") return err("github_read_failed");
        if (!target.value.found) return err("not_found");
        return this.runDurableWrite(
          input,
          {
            _tag: "Reply",
            expected: command.expected,
            actor: actor.value,
            threadId: threadId.value,
            body: command.body.trim(),
          },
          () =>
            createThreadReply({
              profile: fresh.value.profile,
              threadId: threadId.value,
              body: command.body.trim(),
            }),
          (created) =>
            created.reviewId === undefined
              ? { _tag: "ReplyCreated", commentId: created.commentId }
              : {
                  _tag: "ReplyCreated",
                  commentId: created.commentId,
                  reviewId: created.reviewId,
                },
        );
      }
      case "SetThreadState": {
        const command = input.command;
        const setReviewThreadState = this.github.setReviewThreadState?.bind(
          this.github,
        );
        if (setReviewThreadState === undefined)
          return err("github_write_failed");
        const threadId = parseGitHubThreadId(command.threadId);
        if (threadId._tag === "err") return err("not_found");
        const target = await this.github.getReviewThreadTarget({
          profile: fresh.value.profile,
          pr,
          threadId: threadId.value,
        });
        if (target._tag === "err") return err("github_read_failed");
        if (!target.value.found) return err("not_found");
        return this.runDurableWrite(
          input,
          {
            _tag: "SetThreadState",
            expected: command.expected,
            threadId: threadId.value,
            state: command.state,
          },
          () =>
            setReviewThreadState({
              profile: fresh.value.profile,
              threadId: threadId.value,
              state: command.state,
            }),
          () => ({
            _tag: "ThreadStateChanged",
            threadId: command.threadId,
            state: command.state,
          }),
        );
      }
      case "EditComment":
      case "DeleteComment": {
        const commentId = parseGitHubReviewCommentId(input.command.commentId);
        if (commentId._tag === "err") return err("invalid_input");
        const authorized = await this.ownedComment(
          fresh.value.profile,
          pr,
          input.command.commentId,
        );
        if (authorized._tag === "err") return authorized;
        if (input.command._tag === "EditComment") {
          const command = input.command;
          const updateThreadComment = this.github.updateThreadComment?.bind(
            this.github,
          );
          if (updateThreadComment === undefined)
            return err("github_write_failed");
          return this.runDurableWrite(
            input,
            {
              _tag: "EditComment",
              expected: command.expected,
              commentId: commentId.value,
              body: command.body.trim(),
            },
            () =>
              updateThreadComment({
                profile: fresh.value.profile,
                commentId: command.commentId,
                body: command.body.trim(),
              }),
            () => ({
              _tag: "CommentEdited",
              commentId: command.commentId,
            }),
          );
        }
        const deleteThreadComment = this.github.deleteThreadComment?.bind(
          this.github,
        );
        if (deleteThreadComment === undefined)
          return err("github_write_failed");
        const command = input.command;
        return this.runDurableWrite(
          input,
          {
            _tag: "DeleteComment",
            expected: command.expected,
            commentId: commentId.value,
          },
          () =>
            deleteThreadComment({
              profile: fresh.value.profile,
              commentId: command.commentId,
            }),
          () => ({
            _tag: "CommentDeleted",
            commentId: command.commentId,
          }),
        );
      }
    }
  }

  private async runDurableWrite<T>(
    input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly command: DirectConversationCommand;
    },
    intent: Extract<ReviewWriteIntent, { readonly expected: unknown }>,
    write: () => Promise<Result<T, GitHubWriteFailure>>,
    toReceipt: (value: T) => DirectConversationReceipt,
  ): Promise<Result<DirectConversationReceipt, DirectConversationFailure>> {
    const operation: ReviewWriteOperation = {
      schemaVersion: 1,
      profileId: input.profileId,
      reviewId: input.reviewId,
      sessionId: intent.expected.sessionId,
      intent,
      state: { _tag: "Requested" },
      startedAt: this.now(),
    };
    const begun = await this.operations.begin(operation);
    if (begun._tag === "err") return err("outcome_unknown");
    const outcomeUnknown = markReviewWriteOutcomeUnknown(operation);
    if (outcomeUnknown._tag === "err") return err("outcome_unknown");
    const marked = await this.operations.markOutcomeUnknown(
      outcomeUnknown.value,
    );
    if (marked._tag === "err") return err("outcome_unknown");
    let result: Result<T, GitHubWriteFailure>;
    try {
      result = await write();
    } catch {
      return err("outcome_unknown");
    }
    if (result._tag === "err") {
      if (result.error.category === "unavailable")
        return err("outcome_unknown");
      const rejected = await this.operations.reject(operation);
      if (rejected._tag === "err") return err("outcome_unknown");
      return err(mapWriteFailure(result.error));
    }
    const receipt = toReceipt(result.value);
    const journalEntry = journalEntryFor(receipt);
    const confirmedOperation = confirmReviewWrite(
      outcomeUnknown.value,
      journalEntry,
    );
    if (confirmedOperation._tag === "err") return err("outcome_unknown");
    const confirmed = await this.operations.confirm(confirmedOperation.value);
    if (confirmed._tag === "err") return err("outcome_unknown");
    if (journalEntry !== undefined) {
      const appended = await this.recentWrites.append(
        input.profileId,
        input.reviewId,
        journalEntry,
        this.now(),
      );
      if (appended._tag === "err") return err("outcome_unknown");
    }
    const removed = await this.operations.remove(
      input.profileId,
      input.reviewId,
    );
    if (removed._tag === "err") return err("outcome_unknown");
    return ok(receipt);
  }

  private async ownedComment(
    profile: Parameters<Gateway["getReviewCommentTarget"]>[0]["profile"],
    pr: Parameters<Gateway["getReviewCommentTarget"]>[0]["pr"],
    commentId: string,
  ): Promise<Result<void, DirectConversationFailure>> {
    const target = await this.github.getReviewCommentTarget({
      profile,
      pr,
      commentId,
    });
    if (target._tag === "err") return err("github_read_failed");
    if (!target.value.found) return err("not_found");
    return target.value.viewerDidAuthor === true
      ? ok(undefined)
      : err("permission_denied");
  }
}

/**
 * Map one confirmed write receipt to the typed own-write journal entry it
 * proves. `ThreadStateChanged`'s receipt carries a plain string threadId, not
 * the already-branded `GitHubThreadId` the domain type requires, so it is
 * re-parsed here rather than assumed valid.
 */
function journalEntryFor(
  receipt: DirectConversationReceipt,
): RecentReviewWrite | undefined {
  switch (receipt._tag) {
    case "CommentCreated":
    case "ReplyCreated":
      return receipt.reviewId === undefined
        ? { _tag: "Comment", commentId: receipt.commentId }
        : {
            _tag: "Comment",
            commentId: receipt.commentId,
            reviewId: receipt.reviewId,
          };
    case "ThreadStateChanged": {
      const threadId = parseGitHubThreadId(receipt.threadId);
      return threadId._tag === "err"
        ? undefined
        : {
            _tag: "ThreadState",
            threadId: threadId.value,
            state: receipt.state,
          };
    }
    case "CommentEdited":
      return { _tag: "Comment", commentId: receipt.commentId };
    case "CommentDeleted":
      return undefined;
  }
}

function validateLocalCommand(
  command: DirectConversationCommand,
): Result<void, DirectConversationFailure> {
  if (
    (command._tag === "CreateComment" ||
      command._tag === "Reply" ||
      command._tag === "EditComment") &&
    command.body.trim().length === 0
  )
    return err("invalid_input");
  if (command._tag === "DeleteComment" && !command.confirmation)
    return err("confirmation_required");
  if (
    command._tag === "CreateComment" &&
    coordinatesFor(command.anchor) === undefined
  )
    return err("invalid_input");
  if (
    (command._tag === "Reply" || command._tag === "SetThreadState") &&
    parseGitHubThreadId(command.threadId)._tag === "err"
  )
    return err("not_found");
  return ok(undefined);
}

function coordinatesFor(
  anchor: Extract<
    DirectConversationCommand,
    { readonly _tag: "CreateComment" }
  >["anchor"],
): GitHubReviewCoordinates | undefined {
  if (
    !Number.isInteger(anchor.startLine) ||
    !Number.isInteger(anchor.line) ||
    anchor.startLine < 1 ||
    anchor.line < anchor.startLine
  )
    return undefined;
  const side = anchor.side === "new" ? "RIGHT" : "LEFT";
  return anchor.startLine === anchor.line
    ? { path: anchor.path, line: anchor.line, side }
    : {
        path: anchor.path,
        start_line: anchor.startLine,
        start_side: side,
        line: anchor.line,
        side,
      };
}

function mapWriteFailure(
  failure: GitHubWriteFailure,
): DirectConversationFailure {
  switch (failure.category) {
    case "pending_review":
      return "pending_review";
    case "rate_limited":
      return "rate_limited";
    case "forbidden":
      return "forbidden";
    case "auth":
      return "permission_denied";
    case "rejected":
      return "github_write_failed";
    case "unavailable":
      return "outcome_unknown";
  }
}
