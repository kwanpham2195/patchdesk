import { useEffect, useState } from "react";

import type { GitHubThreadId } from "../../../domain/ids";
import { PullRequestDescriptionPreview } from "./pull-request-description";
import { Button } from "@/components/ui/button";
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
  readonly onReply?: (
    threadId: string,
    body: string,
  ) => Promise<string | void>;
  readonly onEditComment?: (commentId: string, body: string) => Promise<void>;
  readonly onDeleteComment?: (commentId: string) => Promise<void>;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly author: string;
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
  const [error, setError] = useState<string>();
  const editable =
    comment.viewerDidAuthor === true &&
    (onEdit !== undefined || onDelete !== undefined);
  return (
    <div>
      <p className="font-semibold">{comment.author}</p>
      {editing ? (
        <div className="mt-1">
          <Textarea
            aria-label="Edit comment"
            value={editBody}
            onChange={(event) => setEditBody(event.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={async () => {
                if (
                  editBody.trim().length === 0 ||
                  saving ||
                  onEdit === undefined
                )
                  return;
                setSaving(true);
                setError(undefined);
                try {
                  await onEdit(comment.id, editBody);
                  setEditing(false);
                } catch {
                  setError("Patchdesk could not edit this comment.");
                } finally {
                  setSaving(false);
                }
              }}
              disabled={editBody.trim().length === 0 || saving}
            >
              {saving ? "Saving…" : "Save"}
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
      {editable && !editing ? (
        <div className="mt-1 flex gap-3">
          <button
            type="button"
            className="text-xs font-medium text-sky-400 hover:underline"
            onClick={() => {
              setEditing(true);
              setEditBody(comment.body);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="text-xs font-medium text-destructive hover:underline"
            onClick={() => {
              if (!window.confirm("Delete this published comment?")) return;
              if (onDelete === undefined) return;
              void onDelete(comment.id).catch(() =>
                setError("Patchdesk could not delete this comment."),
              );
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
      {error === undefined ? null : (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function ConversationThreadCard({
  thread,
}: {
  readonly thread: ConversationThreadCardData;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string>();
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
          Reply and Resolve aren&apos;t available for this comment yet.
          Refresh to pick up its GitHub thread.
        </p>
      ) : null}
      {thread.onSetState === undefined ? null : (
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError(undefined);
            const action = thread.onSetState;
            if (action === undefined || threadId === undefined) return;
            void action(
              threadId,
              thread.state === "resolved" ? "open" : "resolved",
            )
              .catch(() => setError("Patchdesk could not update this thread."))
              .finally(() => setPending(false));
          }}
        >
          {pending
            ? "Updating…"
            : thread.state === "resolved"
              ? "Unresolve"
              : "Resolve"}
        </Button>
      )}
      {error === undefined ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {thread.onReply === undefined ? null : (
        <div className="mt-4 border-t pt-3">
          <Textarea
            aria-label="Reply"
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            placeholder="Write a reply…"
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={async () => {
                if (replyBody.trim().length === 0 || replying) return;
                setReplying(true);
                setError(undefined);
                try {
                  const action = thread.onReply;
                  if (action === undefined || threadId === undefined) return;
                  const commentId = await action(threadId, replyBody);
                  setReplyBody("");
                  if (commentId !== undefined) {
                    setOptimisticReplies((current) => [
                      ...current,
                      {
                        id: commentId,
                        body: replyBody,
                        createdAt: new Date().toISOString(),
                      },
                    ]);
                  }
                } catch {
                  setError("Patchdesk could not publish this reply.");
                } finally {
                  setReplying(false);
                }
              }}
              disabled={replyBody.trim().length === 0 || replying}
            >
              {replying ? "Replying…" : "Reply"}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
