import { useCallback } from "react";

import { parseGitHubThreadId } from "../../../domain/ids";
import { requestJson } from "../api-client";
import type { LocalCommentAuthoringSaveInput } from "../components/review-diff-view";
import { parseDirectConversationReceipt } from "./review-workbench-receipts";
import type { WorkbenchResponse } from "../renderer-contracts";
import type {
  RunDirectCommand,
  AppendRecentWrites,
} from "./use-review-observation";

export type DirectConversationActions = {
  readonly saveInlineComment: (
    input: LocalCommentAuthoringSaveInput,
  ) => Promise<{
    readonly commentId: string;
    readonly threadId?: string;
  } | void>;
  readonly setThreadState: (
    threadId: string,
    state: "open" | "resolved",
  ) => Promise<void>;
  readonly replyToThread: (
    threadId: string,
    body: string,
  ) => Promise<string | void>;
  readonly editComment: (commentId: string, body: string) => Promise<void>;
  readonly deleteComment: (commentId: string) => Promise<void>;
};

export type DirectConversationActionsInput = {
  readonly workbench: WorkbenchResponse;
  readonly runDirectCommand: RunDirectCommand;
  readonly appendRecentWrites: AppendRecentWrites;
};

/** Owns direct published-conversation commands and their local write journal. */
export function useDirectConversationActions({
  workbench,
  runDirectCommand,
  appendRecentWrites,
}: DirectConversationActionsInput): DirectConversationActions {
  const saveInlineComment = useCallback(
    async (
      input: LocalCommentAuthoringSaveInput,
    ): Promise<{
      readonly commentId: string;
      readonly threadId?: string;
    } | void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept comments.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "CreateComment",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              anchor: {
                path: input.path,
                startLine: input.startLine,
                line: input.line,
                side: input.side,
              },
              body: input.body,
            },
          },
        }),
      );
      const receipt = parseDirectConversationReceipt(value);
      if (receipt?._tag === "CommentCreated") {
        const commentWrite = {
          _tag: "Comment" as const,
          commentId: receipt.commentId,
        };
        appendRecentWrites(
          receipt.reviewId === undefined
            ? commentWrite
            : { ...commentWrite, reviewId: receipt.reviewId },
        );
        const created = { commentId: receipt.commentId };
        return receipt.threadId === undefined
          ? created
          : { ...created, threadId: receipt.threadId };
      }
      // A malformed success envelope is a bounded command failure: it must not
      // confirm a local mutation or journal a write that never verified.
      return undefined;
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const setThreadState = useCallback(
    async (threadId: string, state: "open" | "resolved"): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot update this thread.");
      const parsedThreadId = parseGitHubThreadId(threadId);
      if (parsedThreadId._tag === "err")
        throw new Error("The thread id is not valid for this Review.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "SetThreadState",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              threadId,
              state,
            },
          },
        }),
      );
      const receipt = parseDirectConversationReceipt(value);
      if (receipt?._tag === "ThreadStateChanged") {
        appendRecentWrites({
          _tag: "ThreadState",
          threadId: parsedThreadId.value,
          state,
        });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const replyToThread = useCallback(
    async (threadId: string, body: string): Promise<string | void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept replies.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "Reply",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              threadId,
              body,
            },
          },
        }),
      );
      const receipt = parseDirectConversationReceipt(value);
      if (receipt?._tag === "ReplyCreated") {
        const commentWrite = {
          _tag: "Comment" as const,
          commentId: receipt.commentId,
        };
        appendRecentWrites(
          receipt.reviewId === undefined
            ? commentWrite
            : { ...commentWrite, reviewId: receipt.reviewId },
        );
        return receipt.commentId;
      }
      return undefined;
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const editComment = useCallback(
    async (commentId: string, body: string): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot edit comments.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "EditComment",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              commentId,
              body,
            },
          },
        }),
      );
      if (parseDirectConversationReceipt(value)?._tag === "CommentEdited") {
        appendRecentWrites({ _tag: "Comment", commentId });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const deleteComment = useCallback(
    async (commentId: string): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot delete comments.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "DeleteComment",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              commentId,
              confirmation: true,
            },
          },
        }),
      );
      if (parseDirectConversationReceipt(value)?._tag === "CommentDeleted") {
        appendRecentWrites({ _tag: "Comment", commentId });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  return {
    saveInlineComment,
    setThreadState,
    replyToThread,
    editComment,
    deleteComment,
  };
}
