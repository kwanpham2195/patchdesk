import { useEffect, useId, useRef, useState } from "react";

import type { GitHubThreadId } from "../../../domain/ids";
import { PatchdeskApiError } from "../api-client";
import { PullRequestDescriptionPreview } from "./pull-request-description";
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

export type ReviewConversationActions = {
  readonly setThreadState?: (
    threadId: string,
    state: "open" | "resolved",
  ) => Promise<void>;
  readonly replyToThread?: (
    threadId: string,
    body: string,
  ) => Promise<string | void>;
  readonly editComment?: (commentId: string, body: string) => Promise<void>;
  readonly deleteComment?: (commentId: string) => Promise<void>;
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
  readonly target: ConversationThreadTarget;
  readonly state: "open" | "resolved" | "outdated" | "unknown";
  readonly complete?: boolean | undefined;
  readonly onSetState?: (
    threadId: string,
    state: "open" | "resolved",
  ) => Promise<void>;
  readonly onReply?: (threadId: string, body: string) => Promise<string | void>;
  readonly onEditComment?: (commentId: string, body: string) => Promise<void>;
  readonly onDeleteComment?: (commentId: string) => Promise<void>;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly author: string;
    /** `data:` URI resolved from the avatar cache; absent when never synced, failed, or the author has none. */
    readonly authorAvatarDataUri?: string | undefined;
    readonly body: string;
    readonly createdAt: string;
    readonly viewerDidAuthor?: boolean | undefined;
  }>;
};

type ConversationComment = ConversationThreadCardData["comments"][number];
type ThreadStateFailure = {
  readonly message: string;
  readonly ariaLabel?: string;
};

function threadStateFailure(cause: unknown): ThreadStateFailure {
  if (cause instanceof PatchdeskApiError && cause.kind === "forbidden")
    return {
      message:
        "GitHub denied this thread update. Use an authorized account with repository write access.",
      ariaLabel: "GitHub write permission required",
    };
  return { message: "Patchdesk could not update this thread." };
}

/**
 * One comment row shared by opening comments, represented replies, and
 * optimistic published replies. A viewer-authored comment with edit/delete
 * handlers exposes the same controls everywhere, so a reply is editable and
 * deletable exactly like the opening comment.
 */
function ConversationCommentRow({
  comment,
  onEdit,
  onDelete,
}: {
  readonly comment: ConversationComment;
  readonly onEdit?: (commentId: string, body: string) => Promise<void>;
  readonly onDelete?: (commentId: string) => Promise<void>;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState("");
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
                onChange={(event) => setEditBody(event.target.value)}
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
                    await onEdit(comment.id, editBody);
                    setEditing(false);
                  } catch {
                    setError("Patchdesk could not edit this comment.");
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
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <PullRequestDescriptionPreview markdown={comment.body} />
        )}
        {error !== undefined && !editing ? (
          <InlineError className="mt-1">{error}</InlineError>
        ) : null}
        {(canEdit || canDelete) && !editing ? (
          <div className="mt-1 flex gap-3">
            {canEdit ? (
              <button
                type="button"
                className="text-xs font-medium text-sky-400 hover:underline"
                disabled={deleting}
                onClick={() => {
                  setEditing(true);
                  setEditBody(comment.body);
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
                className="h-auto p-0 text-xs text-destructive"
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
                  } catch {
                    setError("Patchdesk could not delete this comment.");
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
}: {
  readonly thread: ConversationThreadCardData;
  /** Stable id (the owning `ReviewInlineAnnotation.id`) that `{`/`}` comment
   * navigation in `review-diff-view.tsx` uses to find and focus this exact
   * card after a jump lands on it. Absent for render paths outside that
   * navigation surface (e.g. the Conversation tab's general-thread list). */
  readonly navAnchorId?: string;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replying, setReplying] = useState(false);
  const replyingRef = useRef(false);
  const [error, setError] = useState<ThreadStateFailure>();
  const [replyError, setReplyError] = useState<string>();
  const replyEditorId = `thread-reply-${useId()}`;
  const replyErrorId = `${replyEditorId}-error`;
  const [optimisticReplies, setOptimisticReplies] = useState<
    ReadonlyArray<{
      readonly id: string;
      readonly body: string;
      readonly createdAt: string;
    }>
  >([]);
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
  // Only a canonical thread target carries a GitHub thread id; comment-only
  // cards (fresh REST creates) have none, and their callbacks never exist.
  const threadId =
    thread.target._tag === "thread" ? thread.target.id : undefined;
  const threadWriteBusy = pending || replying;
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
            {...(rowEdit === undefined ? {} : { onEdit: rowEdit })}
            {...(rowDelete === undefined ? {} : { onDelete: rowDelete })}
          />
        </div>
      ) : null}
      {optimisticReplies.map((reply) => (
        <div key={reply.id} className="mt-4 border-l-2 border-border/70 pl-4">
          <ConversationCommentRow
            comment={{ ...reply, author: "You", viewerDidAuthor: true }}
            {...(rowEdit === undefined
              ? {}
              : {
                  onEdit: async (commentId, body) => {
                    await rowEdit(commentId, body);
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
                  onDelete: async (commentId) => {
                    await rowDelete(commentId);
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
          className="mt-3 text-xs font-medium text-sky-400 hover:underline"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded
            ? `Hide ${hiddenReplyCount} replies`
            : `Show ${hiddenReplyCount} replies`}
        </button>
      ) : null}
      {thread.target._tag === "comment_only" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Reply and Resolve aren&apos;t available for this comment yet. Refresh
          to pick up its GitHub thread.
        </p>
      ) : null}
      {thread.onSetState === undefined ? null : (
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          disabled={threadWriteBusy}
          onClick={async () => {
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
          }}
        >
          {pending ? (
            <>
              <Spinner data-icon="inline-start" />
              {thread.state === "resolved" ? "Unresolving…" : "Resolving…"}
            </>
          ) : thread.state === "resolved" ? (
            "Unresolve"
          ) : (
            "Resolve"
          )}
        </Button>
      )}
      {error === undefined ? null : (
        <InlineError className="mt-2" aria-label={error.ariaLabel}>
          {error.message}
        </InlineError>
      )}
      {thread.onReply === undefined ? null : (
        <div className="mt-4 border-t pt-3">
          <Field
            data-invalid={replyError !== undefined || undefined}
            data-disabled={threadWriteBusy || undefined}
          >
            <Textarea
              id={replyEditorId}
              aria-label="Reply"
              aria-invalid={replyError !== undefined || undefined}
              aria-describedby={
                replyError === undefined ? undefined : replyErrorId
              }
              value={replyBody}
              onChange={(event) => setReplyBody(event.target.value)}
              placeholder="Write a reply…"
              disabled={threadWriteBusy}
            />
            <FieldError id={replyErrorId}>{replyError}</FieldError>
          </Field>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={async () => {
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
                  setReplyBody("");
                  if (commentId !== undefined) {
                    setOptimisticReplies((current) => [
                      ...current,
                      {
                        id: commentId,
                        body: submittedBody,
                        createdAt: new Date().toISOString(),
                      },
                    ]);
                  }
                } catch {
                  setReplyError("Patchdesk could not publish this reply.");
                } finally {
                  replyingRef.current = false;
                  setReplying(false);
                }
              }}
              disabled={replyBody.trim().length === 0 || threadWriteBusy}
            >
              {replying ? (
                <>
                  <Spinner data-icon="inline-start" /> Replying…
                </>
              ) : (
                "Reply"
              )}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
