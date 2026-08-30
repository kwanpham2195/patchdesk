import { useCallback, useRef } from "react";

import type { RawJsonValue } from "../../../domain/json";
import type { RecentReviewWrite } from "../../../domain/recent-review-write";
import { parseGitHubThreadId } from "../../../domain/ids";
import {
  isOutcomeUnknownRetry,
  PatchdeskApiError,
  requestJson,
} from "../api-client";
import type { LocalCommentAuthoringSaveInput } from "../components/review-diff-view";
import {
  parseDirectConversationReceipt,
  parsePublishedFeedbackReceipt,
} from "./review-workbench-receipts";
import type {
  RemoteWriteRecovery,
  WorkbenchResponse,
} from "../renderer-contracts";
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
  readonly dismissReview: (
    publishedReviewId: string,
    message: string,
  ) => Promise<void>;
};

export type DirectConversationActionsInput = {
  readonly workbench: WorkbenchResponse;
  readonly runDirectCommand: RunDirectCommand;
  readonly appendRecentWrites: AppendRecentWrites;
  readonly observeConfirmedReviewWrite: (
    recentWrites?: ReadonlyArray<RecentReviewWrite>,
  ) => Promise<void>;
  readonly requireRecovery: (
    operation: RemoteWriteRecovery["operation"],
  ) => void;
};

/** Owns direct published-conversation commands and their local write journal. */
export function useDirectConversationActions({
  workbench,
  runDirectCommand,
  appendRecentWrites,
  observeConfirmedReviewWrite,
  requireRecovery,
}: DirectConversationActionsInput): DirectConversationActions {
  const commandInFlightRef = useRef(false);

  const runCommand = useCallback(
    async <Receipt>(
      operation: RemoteWriteRecovery["operation"],
      request: () => Promise<RawJsonValue | undefined>,
      parseReceipt: (value: RawJsonValue | undefined) => Receipt | undefined,
      receiptMatches: (receipt: Receipt) => boolean,
    ): Promise<Receipt | undefined> => {
      if (commandInFlightRef.current) return undefined;
      commandInFlightRef.current = true;
      try {
        let value: RawJsonValue | undefined;
        try {
          value = await runDirectCommand(request);
        } catch (cause) {
          if (
            isOutcomeUnknownRetry(cause) ||
            (cause instanceof PatchdeskApiError && cause.kind === "unavailable")
          )
            requireRecovery(operation);
          throw cause;
        }
        const receipt = parseReceipt(value);
        if (receipt === undefined || !receiptMatches(receipt)) {
          requireRecovery(operation);
          throw new Error("The direct-conversation response was malformed.");
        }
        return receipt;
      } finally {
        commandInFlightRef.current = false;
      }
    },
    [requireRecovery, runDirectCommand],
  );

  const confirmRecentWrite = useCallback(
    (write: RecentReviewWrite): void => {
      appendRecentWrites(write);
      void observeConfirmedReviewWrite([write]).catch(() => undefined);
    },
    [appendRecentWrites, observeConfirmedReviewWrite],
  );

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
      const receipt = await runCommand(
        "CreateComment",
        () =>
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
        parseDirectConversationReceipt,
        (candidate) => candidate._tag === "CommentCreated",
      );
      if (receipt?._tag !== "CommentCreated") return undefined;
      const commentWrite: RecentReviewWrite =
        receipt.reviewId === undefined
          ? { _tag: "Comment", commentId: receipt.commentId }
          : {
              _tag: "Comment",
              commentId: receipt.commentId,
              reviewId: receipt.reviewId,
            };
      confirmRecentWrite(commentWrite);
      const created = { commentId: receipt.commentId };
      return receipt.threadId === undefined
        ? created
        : { ...created, threadId: receipt.threadId };
    },
    [confirmRecentWrite, runCommand, workbench],
  );

  const setThreadState = useCallback(
    async (threadId: string, state: "open" | "resolved"): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot update this thread.");
      const parsedThreadId = parseGitHubThreadId(threadId);
      if (parsedThreadId._tag === "err")
        throw new Error("The thread id is not valid for this Review.");
      const receipt = await runCommand(
        "SetThreadState",
        () =>
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
        parseDirectConversationReceipt,
        (candidate) =>
          candidate._tag === "ThreadStateChanged" &&
          candidate.threadId === parsedThreadId.value &&
          candidate.state === state,
      );
      if (receipt?._tag !== "ThreadStateChanged") return;
      confirmRecentWrite({
        _tag: "ThreadState",
        threadId: receipt.threadId,
        state: receipt.state,
      });
    },
    [confirmRecentWrite, runCommand, workbench],
  );

  const replyToThread = useCallback(
    async (threadId: string, body: string): Promise<string | void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept replies.");
      const receipt = await runCommand(
        "Reply",
        () =>
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
        parseDirectConversationReceipt,
        (candidate) => candidate._tag === "ReplyCreated",
      );
      if (receipt?._tag !== "ReplyCreated") return undefined;
      confirmRecentWrite(
        receipt.reviewId === undefined
          ? { _tag: "Comment", commentId: receipt.commentId }
          : {
              _tag: "Comment",
              commentId: receipt.commentId,
              reviewId: receipt.reviewId,
            },
      );
      return receipt.commentId;
    },
    [confirmRecentWrite, runCommand, workbench],
  );

  const editComment = useCallback(
    async (commentId: string, body: string): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot edit comments.");
      const receipt = await runCommand(
        "EditPublishedComment",
        () =>
          requestJson("/v1/reviews/published-comments/edit", {
            method: "POST",
            body: publishedRequest(workbench, patchHash, { commentId, body }),
          }),
        parsePublishedFeedbackReceipt,
        (candidate) =>
          candidate._tag === "PublishedCommentEdited" &&
          candidate.commentId === commentId,
      );
      if (
        receipt?._tag === "PublishedCommentEdited" &&
        receipt.reconciliation === "required"
      )
        requireRecovery("EditPublishedComment");
    },
    [requireRecovery, runCommand, workbench],
  );

  const deleteComment = useCallback(
    async (commentId: string): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot delete comments.");
      const receipt = await runCommand(
        "DeletePublishedComment",
        () =>
          requestJson("/v1/reviews/published-comments/delete", {
            method: "POST",
            body: publishedRequest(workbench, patchHash, {
              commentId,
              confirmation: true,
            }),
          }),
        parsePublishedFeedbackReceipt,
        (candidate) =>
          candidate._tag === "PublishedCommentDeleted" &&
          candidate.commentId === commentId,
      );
      if (
        receipt?._tag === "PublishedCommentDeleted" &&
        receipt.reconciliation === "required"
      )
        requireRecovery("DeletePublishedComment");
    },
    [requireRecovery, runCommand, workbench],
  );

  const dismissReview = useCallback(
    async (publishedReviewId: string, message: string): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot dismiss reviews.");
      const receipt = await runCommand(
        "DismissPublishedReview",
        () =>
          requestJson("/v1/reviews/published-reviews/dismiss", {
            method: "POST",
            body: publishedRequest(workbench, patchHash, {
              publishedReviewId,
              message,
              confirmation: true,
            }),
          }),
        parsePublishedFeedbackReceipt,
        (candidate) =>
          candidate._tag === "PublishedReviewDismissed" &&
          candidate.publishedReviewId === publishedReviewId,
      );
      if (
        receipt?._tag === "PublishedReviewDismissed" &&
        receipt.reconciliation === "required"
      )
        requireRecovery("DismissPublishedReview");
    },
    [requireRecovery, runCommand, workbench],
  );

  return {
    saveInlineComment,
    setThreadState,
    replyToThread,
    editComment,
    deleteComment,
    dismissReview,
  };
}

function publishedRequest<Command extends Record<string, string | boolean>>(
  workbench: WorkbenchResponse,
  patchHash: NonNullable<WorkbenchResponse["revision"]["patchHash"]>,
  command: Command,
): {
  readonly profileId: string;
  readonly reviewId: string;
  readonly expected: {
    readonly sessionId: string;
    readonly headSha: string;
    readonly patchHash: string;
  };
} & Command {
  return {
    profileId: workbench.session.key.profileId,
    reviewId: workbench.review.id,
    expected: {
      sessionId: workbench.session.id,
      headSha: workbench.revision.reviewedHeadSha,
      patchHash,
    },
    ...command,
  };
}
