import { useId, useRef, useState } from "react";
import type { ConversationThreadCardData } from "#src/renderer/src/components/conversation-thread-card";
import { useReviewConversationDraft } from "./use-review-conversation-owner";
import { useReportUnsentReviewText } from "./use-unsent-review-text";
import {
  PatchdeskApiError,
  contextualMessage,
  refusedWriteMessage,
} from "#src/renderer/src/api-client";
import { THREAD_REPLY_MESSAGES } from "#src/renderer/src/review-copy";

type ThreadStateFailure = {
  readonly message: string;
  readonly ariaLabel?: string;
};

function threadStateFailure(cause: unknown): ThreadStateFailure {
  const refused = refusedWriteMessage(cause, "thread update");
  if (refused !== undefined) return { message: refused };
  if (cause instanceof PatchdeskApiError && cause.kind === "forbidden")
    return {
      message:
        "GitHub denied this thread update. Use an authorized account with repository write access.",
      ariaLabel: "GitHub write permission required",
    };
  return { message: "Patchdesk could not update this thread." };
}

/** Card-scoped controls keep admission and draft lifetime independent of readable comments. */
export type ConversationThreadActionControls = {
  readonly pending: boolean;
  readonly replying: boolean;
  readonly busy: boolean;
  readonly error: ThreadStateFailure | undefined;
  readonly replyError: string | undefined;
  readonly replyEditorId: string;
  readonly replyBody: string;
  readonly setReplyBody: (body: string) => void;
  readonly setThreadState: () => Promise<void>;
  readonly reply: () => Promise<void>;
};

/** Reply and resolve share synchronous admission and busy state within one card. */
export function useConversationThreadActions(
  thread: ConversationThreadCardData,
  onReplyPublished: (reply: {
    readonly id: string;
    readonly body: string;
    readonly createdAt: string;
  }) => void,
): ConversationThreadActionControls {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const replyDraft = useReviewConversationDraft(
    thread.conversationOwner,
    thread.target._tag === "thread"
      ? `reply:${thread.target.id}`
      : "reply:unavailable",
  );
  const replyBody = replyDraft.body ?? "";
  useReportUnsentReviewText(
    thread.conversationOwner === undefined ? replyBody : "",
  );
  const [replying, setReplying] = useState(false);
  const replyingRef = useRef(false);
  const [error, setError] = useState<ThreadStateFailure>();
  const [replyError, setReplyError] = useState<string>();
  const replyEditorId = `thread-reply-${useId()}`;
  const threadId =
    thread.target._tag === "thread" ? thread.target.id : undefined;
  return {
    pending,
    replying,
    busy: pending || replying,
    error,
    replyError,
    replyEditorId,
    replyBody,
    setReplyBody: replyDraft.setBody,
    setThreadState: async () => {
      if (pendingRef.current || replyingRef.current) return;
      const action = thread.onSetState;
      if (action === undefined || threadId === undefined) return;
      pendingRef.current = true;
      setPending(true);
      setError(undefined);
      try {
        await action(
          threadId,
          thread.state === "resolved" ? "open" : "resolved",
        );
      } catch (cause) {
        setError(threadStateFailure(cause));
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    reply: async () => {
      if (
        replyBody.trim().length === 0 ||
        replyingRef.current ||
        pendingRef.current
      )
        return;
      const action = thread.onReply;
      if (action === undefined || threadId === undefined) return;
      const submittedBody = replyBody;
      replyingRef.current = true;
      setReplying(true);
      setError(undefined);
      setReplyError(undefined);
      try {
        const commentId = await action(threadId, submittedBody);
        if (commentId !== undefined || thread.conversationOwner === undefined)
          replyDraft.clearSubmitted(submittedBody);
        if (commentId !== undefined && thread.conversationOwner === undefined) {
          onReplyPublished({
            id: commentId,
            body: submittedBody,
            createdAt: new Date().toISOString(),
          });
        }
      } catch (cause) {
        setReplyError(contextualMessage(cause, THREAD_REPLY_MESSAGES));
      } finally {
        replyingRef.current = false;
        setReplying(false);
      }
    },
  };
}
