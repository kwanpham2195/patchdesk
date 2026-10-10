import { useEffect, useId, useRef, useState } from "react";

import type { GitHubThreadId } from "#src/domain/ids";
import {
  useReviewConversationDraft,
  type ReviewConversationOwner,
} from "#src/renderer/src/hooks/use-review-conversation-owner";
import { contextualMessage } from "#src/renderer/src/api-client";
import { ConversationThreadActions } from "./conversation-thread-actions";
import { useConversationThreadActions } from "#src/renderer/src/hooks/use-conversation-thread-actions";
import { useReportUnsentReviewText } from "#src/renderer/src/hooks/use-unsent-review-text";
import {
  COMMENT_DELETE_MESSAGES,
  COMMENT_EDIT_MESSAGES,
} from "#src/renderer/src/review-copy";
import {
  EMPTY_BODY_CONTEXT,
  PullRequestDescriptionPreview,
  type PullRequestBodyContext,
} from "./pull-request-description";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { InlineError } from "@/components/ui/inline-error";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/**
 * The write capability of a conversation card: a canonical GitHub thread may
 * receive replies and state changes; a freshly created comment has only a
 * comment id until an explicit refresh represents its real thread; a real
 * thread whose id string failed validation can still show its comments and
 * accept Edit/Delete (which key on each comment's own id), but never Reply/
 * Resolve, which require the branded thread id itself.
 */
export type ConversationThreadTarget =
  | { readonly _tag: "thread"; readonly id: GitHubThreadId }
  | { readonly _tag: "comment_only"; readonly commentId: string }
  | { readonly _tag: "unresolved" };

/** Mutation callbacks return false for skipped admission and fulfilled void for a confirmed write. */
export type ReviewConversationActions = {
  readonly setThreadState?: (
    threadId: string,
    state: "open" | "resolved",
  ) => Promise<false | void>;
  readonly replyToThread?: (
    threadId: string,
    body: string,
  ) => Promise<string | void>;
  readonly editComment?: (
    commentId: string,
    body: string,
  ) => Promise<false | void>;
  readonly deleteComment?: (commentId: string) => Promise<false | void>;
  readonly dismissReview?: (
    publishedReviewId: string,
    message: string,
  ) => Promise<void>;
};

/**
 * The data shape a `ConversationThreadCard` renders, shared by the diff-view
 * inline annotation surface and the Conversation-tab general-thread surface.
 */
export type ConversationThreadCardData = {
  /** Shared only when the card belongs to a diff appearance in this Review session. */
  readonly conversationOwner?: ReviewConversationOwner;
  readonly target: ConversationThreadTarget;
  readonly state: "open" | "resolved" | "outdated" | "unknown";
  readonly complete?: boolean | undefined;
  readonly onSetState?: (
    threadId: string,
    state: "open" | "resolved",
  ) => Promise<false | void>;
  readonly onReply?: (threadId: string, body: string) => Promise<string | void>;
  readonly onEditComment?: (
    commentId: string,
    body: string,
  ) => Promise<false | void>;
  readonly onDeleteComment?: (commentId: string) => Promise<false | void>;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    /** GraphQL identity keeps an edit draft stable when a REST receipt becomes canonical. */
    readonly commentNodeId?: string;
    readonly author: string;
    /** `data:` URI resolved from the avatar cache; absent when never synced, failed, or the author has none. */
    readonly authorAvatarDataUri?: string | undefined;
    readonly body: string;
    readonly createdAt: string;
    readonly viewerDidAuthor?: boolean | undefined;
  }>;
};

type ConversationComment = ConversationThreadCardData["comments"][number];
/**
 * One comment row shared by opening comments, represented replies, and
 * optimistic published replies. A viewer-authored comment with edit/delete
 * handlers exposes the same controls everywhere, so a reply is editable and
 * deletable exactly like the opening comment.
 */
function ConversationCommentRow({
  comment,
  bodyContext,
  onEdit,
  onDelete,
  conversationOwner,
}: {
  readonly conversationOwner?: ReviewConversationOwner | undefined;
  readonly comment: ConversationComment;
  readonly bodyContext: PullRequestBodyContext;
  readonly onEdit?: (commentId: string, body: string) => Promise<false | void>;
  readonly onDelete?: (commentId: string) => Promise<false | void>;
}): React.JSX.Element {
  const [editBase, setEditBase] = useState<{
    readonly owner: ReviewConversationOwner | undefined;
    readonly body: string;
  }>();
  const [localEditBody, setLocalEditBody] = useState("");
  const editDraft = useReviewConversationDraft(
    conversationOwner,
    `edit:${comment.commentNodeId ?? comment.id}`,
  );
  const editing =
    (editBase !== undefined &&
      editBase.owner === conversationOwner &&
      editBase.body === comment.body) ||
    editDraft.body !== undefined;
  const editBody = editDraft.body ?? localEditBody;
  useReportUnsentReviewText(
    conversationOwner === undefined && editing && editBody !== comment.body
      ? editBody
      : "",
  );
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [error, setError] = useState<string>();
  const editorId = `comment-editor-${useId()}`;
  const errorId = `${editorId}-error`;
  const canEdit = comment.viewerDidAuthor === true && onEdit !== undefined;
  const canDelete = comment.viewerDidAuthor === true && onDelete !== undefined;
  return (
    <div className="flex gap-3">
      <Avatar name={comment.author} dataUri={comment.authorAvatarDataUri} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{comment.author}</p>
        {editing ? (
          <div className="mt-1">
            <Field
              data-invalid={error !== undefined || undefined}
              data-disabled={saving || undefined}
            >
              <Textarea
                id={editorId}
                aria-label="Edit comment"
                aria-invalid={error !== undefined || undefined}
                aria-describedby={error === undefined ? undefined : errorId}
                value={editBody}
                onChange={(event) => {
                  const body = event.target.value;
                  setLocalEditBody(body);
                  editDraft.setBody(body === comment.body ? undefined : body);
                }}
                disabled={saving}
              />
              <FieldError id={errorId}>{error}</FieldError>
            </Field>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  if (
                    editBody.trim().length === 0 ||
                    savingRef.current ||
                    onEdit === undefined
                  )
                    return;
                  savingRef.current = true;
                  setSaving(true);
                  setError(undefined);
                  try {
                    if ((await onEdit(comment.id, editBody)) === false) return;
                    editDraft.clearSubmitted(editBody);
                    setEditBase(undefined);
                  } catch (cause) {
                    setError(contextualMessage(cause, COMMENT_EDIT_MESSAGES));
                  } finally {
                    savingRef.current = false;
                    setSaving(false);
                  }
                }}
                disabled={editBody.trim().length === 0 || saving}
              >
                {saving ? (
                  <>
                    <Spinner data-icon="inline-start" /> Saving…
                  </>
                ) : (
                  "Save"
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  editDraft.setBody(undefined);
                  setEditBase(undefined);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <PullRequestDescriptionPreview
            markdown={comment.body}
            {...bodyContext}
          />
        )}
        {error !== undefined && !editing ? (
          <InlineError className="mt-1">{error}</InlineError>
        ) : null}
        {(canEdit || canDelete) && !editing ? (
          <div className="mt-1 flex gap-3">
            {canEdit ? (
              <button
                type="button"
                className="text-xs font-medium text-primary hover:underline"
                disabled={deleting}
                onClick={() => {
                  setEditBase({ owner: conversationOwner, body: comment.body });
                  setLocalEditBody(comment.body);
                }}
              >
                Edit
              </button>
            ) : null}
            {canDelete ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="text-xs text-destructive"
                disabled={deleting}
                onClick={async () => {
                  if (deletingRef.current) return;
                  if (!window.confirm("Delete this published comment?")) return;
                  if (onDelete === undefined) return;
                  deletingRef.current = true;
                  setDeleting(true);
                  setError(undefined);
                  try {
                    await onDelete(comment.id);
                  } catch (cause) {
                    setError(contextualMessage(cause, COMMENT_DELETE_MESSAGES));
                  } finally {
                    deletingRef.current = false;
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? (
                  <>
                    <Spinner data-icon="inline-start" /> Deleting…
                  </>
                ) : (
                  "Delete"
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ConversationThreadCard({
  thread,
  navAnchorId,
  bodyContext = EMPTY_BODY_CONTEXT,
}: {
  readonly thread: ConversationThreadCardData;
  /** What each comment's Markdown resolves its images and links against. */
  readonly bodyContext?: PullRequestBodyContext;
  /** Stable id (the owning `ReviewInlineAnnotation.id`) that `{`/`}` comment
   * navigation in `review-diff-view.tsx` uses to find and focus this exact
   * card after a jump lands on it. Absent for render paths outside that
   * navigation surface (e.g. the Conversation tab's general-thread list). */
  readonly navAnchorId?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [optimisticReplies, setOptimisticReplies] = useState<
    ReadonlyArray<{
      readonly id: string;
      readonly body: string;
      readonly createdAt: string;
    }>
  >([]);
  const actions = useConversationThreadActions(thread, (reply) =>
    setOptimisticReplies((current) => [...current, reply]),
  );
  // A published reply is authoritative (GitHub returned 200); drop its local
  // row once an explicit refresh or reload brings the authoritative thread.
  useEffect(() => {
    const realCommentIds = new Set(
      thread.comments.map((comment) => comment.id),
    );
    setOptimisticReplies((current) =>
      current.some((reply) => realCommentIds.has(reply.id))
        ? current.filter((reply) => !realCommentIds.has(reply.id))
        : current,
    );
  }, [thread.comments]);
  const opening = thread.comments[0];
  const latest = thread.comments.at(-1);
  const hiddenReplyCount = Math.max(
    0,
    thread.comments.length - (opening === latest ? 1 : 2),
  );
  const middleReplies =
    expanded && hiddenReplyCount > 0
      ? thread.comments.slice(
          1,
          thread.comments.length - (opening === latest ? 0 : 1),
        )
      : [];
  const rowEdit = thread.onEditComment;
  const rowDelete = thread.onDeleteComment;
  if (opening === undefined)
    return (
      <p role="status" className="mx-2 my-2 text-sm text-muted-foreground">
        This conversation has no readable comments.
      </p>
    );
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      aria-label={`${thread.state} conversation thread`}
      // Programmatically focusable (not a Tab stop of its own) so `{`/`}`
      // comment navigation can move focus onto the card the keyboard jump
      // landed on; the next Tab then reaches its first real control (Reply,
      // Resolve, or a comment's Edit/Delete link).
      tabIndex={-1}
      {...(navAnchorId === undefined
        ? {}
        : { "data-review-comment-thread": navAnchorId })}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {thread.state === "resolved"
            ? "Resolved"
            : thread.state === "outdated"
              ? "Outdated"
              : "Open"}
        </span>
        {thread.complete === false ? (
          <span>Some replies unavailable</span>
        ) : null}
      </div>
      <div className="mt-2">
        <ConversationCommentRow
          comment={opening}
          bodyContext={bodyContext}
          conversationOwner={thread.conversationOwner}
          {...(rowEdit === undefined ? {} : { onEdit: rowEdit })}
          {...(rowDelete === undefined ? {} : { onDelete: rowDelete })}
        />
      </div>
      {middleReplies.length > 0
        ? middleReplies.map((comment) => (
            <div
              key={comment.id}
              className="mt-4 border-l-2 border-border/70 pl-4"
            >
              <ConversationCommentRow
                comment={comment}
                bodyContext={bodyContext}
                conversationOwner={thread.conversationOwner}
                {...(rowEdit === undefined ? {} : { onEdit: rowEdit })}
                {...(rowDelete === undefined ? {} : { onDelete: rowDelete })}
              />
            </div>
          ))
        : null}
      {latest !== undefined && latest !== opening ? (
        <div className="mt-4 border-l-2 border-border/70 pl-4">
          <ConversationCommentRow
            comment={latest}
            bodyContext={bodyContext}
            conversationOwner={thread.conversationOwner}
            {...(rowEdit === undefined ? {} : { onEdit: rowEdit })}
            {...(rowDelete === undefined ? {} : { onDelete: rowDelete })}
          />
        </div>
      ) : null}
      {optimisticReplies.map((reply) => (
        <div key={reply.id} className="mt-4 border-l-2 border-border/70 pl-4">
          <ConversationCommentRow
            comment={{ ...reply, author: "You", viewerDidAuthor: true }}
            bodyContext={bodyContext}
            {...(rowEdit === undefined
              ? {}
              : {
                  onEdit: async (commentId, body): Promise<false | void> => {
                    if ((await rowEdit(commentId, body)) === false)
                      return false;
                    setOptimisticReplies((current) =>
                      current.map((entry) =>
                        entry.id === commentId ? { ...entry, body } : entry,
                      ),
                    );
                  },
                })}
            {...(rowDelete === undefined
              ? {}
              : {
                  onDelete: async (commentId): Promise<false | void> => {
                    if ((await rowDelete(commentId)) === false) return false;
                    setOptimisticReplies((current) =>
                      current.filter((entry) => entry.id !== commentId),
                    );
                  },
                })}
          />
        </div>
      ))}
      {hiddenReplyCount > 0 ? (
        <button
          type="button"
          className="mt-3 text-xs font-medium text-primary hover:underline"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded
            ? `Hide ${hiddenReplyCount} replies`
            : `Show ${hiddenReplyCount} replies`}
        </button>
      ) : null}
      <ConversationThreadActions thread={thread} controls={actions} />
    </article>
  );
}
