import { useState } from "react";
import { PullRequestDescriptionPreview } from "./pull-request-description";
import type {
  GitHubComment,
  PublishedReview,
} from "../../../domain/github-context";
import { parseGitHubThreadId, parseIsoTimestamp } from "../../../domain/ids";
import type { WorkbenchResponse } from "../renderer-contracts";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import {
  ConversationThreadCard,
  type ConversationThreadCardData,
  type ConversationThreadTarget,
  type ReviewConversationActions,
} from "./conversation-thread-card";

/**
 * Local overrides for a general thread's Resolve/Edit/Delete actions,
 * applied on top of the projection until an explicit refresh or reload
 * re-baselines it. Mirrors `resolvedThreads`/`editedBodies`/
 * `deletedCommentIds` in `review-diff-view.tsx`; onReply needs no override
 * here because its optimistic list lives inside `ConversationThreadCard`.
 * Declared mutable so callers can build it in statements (adding a callback
 * only when its action is wired) instead of a conditional empty-object
 * spread; `Readonly` gives the type every other consumer sees.
 */
type MutableGeneralThreadOverrides = {
  resolvedThreads: ReadonlyMap<string, "open" | "resolved">;
  editedBodies: ReadonlyMap<string, string>;
  deletedCommentIds: ReadonlySet<string>;
  onSetState?: (threadId: string, state: "open" | "resolved") => Promise<void>;
  onReply?: (threadId: string, body: string) => Promise<string | void>;
  onEditComment?: (commentId: string, body: string) => Promise<void>;
  onDeleteComment?: (commentId: string) => Promise<void>;
};
type GeneralThreadOverrides = Readonly<MutableGeneralThreadOverrides>;

export function Conversation({
  conversation,
  conversationActions,
  rail,
}: {
  readonly conversation: WorkbenchResponse["conversation"];
  readonly conversationActions?: ReviewConversationActions;
  /** The pull-request metadata rail (Labels, and later Assignees/Reviewers),
   * built by `ReviewWorkbench` since it holds the model. `Conversation` only
   * owns the layout here — rendering `rail` beside (or, below the
   * `min-[1100px]` breakpoint, beneath) the reading column when supplied,
   * and nothing extra when it's not. That keeps the rail off the Diff and
   * Insights tabs by construction: those tabs never pass it. */
  readonly rail?: React.ReactNode;
}): React.JSX.Element {
  const [resolvedThreads, setResolvedThreads] = useState<
    ReadonlyMap<string, "open" | "resolved">
  >(() => new Map());
  const [editedBodies, setEditedBodies] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [deletedCommentIds, setDeletedCommentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const replyToThread = conversationActions?.replyToThread;
  const setThreadState = conversationActions?.setThreadState;
  const editComment = conversationActions?.editComment;
  const deleteComment = conversationActions?.deleteComment;

  const generalThreadOverrides: MutableGeneralThreadOverrides = {
    resolvedThreads,
    editedBodies,
    deletedCommentIds,
  };
  if (replyToThread !== undefined) {
    generalThreadOverrides.onReply = replyToThread;
  }
  if (setThreadState !== undefined) {
    generalThreadOverrides.onSetState = async (threadId, state) => {
      await setThreadState(threadId, state);
      setResolvedThreads((current) => {
        const next = new Map(current);
        next.set(threadId, state);
        return next;
      });
    };
  }
  if (editComment !== undefined) {
    generalThreadOverrides.onEditComment = async (commentId, body) => {
      await editComment(commentId, body);
      setEditedBodies((current) => {
        const next = new Map(current);
        next.set(commentId, body);
        return next;
      });
    };
  }
  if (deleteComment !== undefined) {
    generalThreadOverrides.onDeleteComment = async (commentId) => {
      await deleteComment(commentId);
      setDeletedCommentIds((current) => {
        const next = new Set(current);
        next.add(commentId);
        return next;
      });
    };
  }

  return (
    <div className="flex-1 overflow-y-auto" data-review-conversation>
      <div className="mx-auto flex w-full max-w-[1024px] flex-col gap-6 px-4 py-4 min-[1100px]:flex-row min-[1100px]:items-start">
        <div
          className="mx-auto w-full min-w-0 max-w-[680px] min-[1100px]:mx-0 min-[1100px]:flex-1"
          data-conversation-reading-column
        >
          {/* PR description */}
          {conversation.prDescription.length > 0 && (
            <div className="mb-4 rounded-md border p-4">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Pull request description
              </p>
              <PullRequestDescriptionPreview
                markdown={conversation.prDescription}
              />
            </div>
          )}

          {/* Timeline entries */}
          <div className="flex flex-col">
            {conversation.prDescription.length === 0 &&
            conversation.entries.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No conversation yet.
              </p>
            ) : (
              conversation.entries.map((entry) => (
                <ConversationTimelineEntry
                  key={conversationEntryKey(entry)}
                  entry={entry}
                  generalThreadOverrides={generalThreadOverrides}
                />
              ))
            )}
          </div>

          {conversation.complete === false && (
            <p className="mt-4 text-xs text-muted-foreground">
              Some conversation was not loaded. Refresh GitHub state to load
              more.
            </p>
          )}
        </div>
        {rail}
      </div>
    </div>
  );
}

function conversationEntryKey(
  entry: WorkbenchResponse["conversation"]["entries"][number],
): string {
  switch (entry._tag) {
    case "PrDescription":
      throw new Error("Pull request descriptions are not timeline entries");
    case "IssueComment":
      return `${entry._tag}-${entry.comment.id}`;
    case "ReviewSummary":
      return `${entry._tag}-${entry.review.id}`;
    case "GeneralThread":
      return `${entry._tag}-${entry.thread.id}`;
  }
}

/** The wire shape of a `GeneralThread` entry's `thread` field, before it is
 * parsed into the domain `GitHubConversationThread` (branded id/timestamps). */
type WireGeneralThread = Extract<
  WorkbenchResponse["conversation"]["entries"][number],
  { readonly _tag: "GeneralThread" }
>["thread"];

type MutableGitHubComment = {
  -readonly [K in keyof GitHubComment]: GitHubComment[K];
};

/** Parses one wire comment into a `GitHubComment`, establishing the
 * `IsoTimestamp` brand `createdAt`/`updatedAt` require. Drops a comment
 * whose `createdAt` fails to parse rather than rendering a bad timestamp —
 * the caller must mark the thread `complete: false` when this happens, so
 * the drop is visible rather than silent (a maintainer cannot act on
 * feedback they never see). */
function parseGeneralThreadComment(
  comment: WireGeneralThread["comments"][number],
): GitHubComment | undefined {
  const parsedCreatedAt = parseIsoTimestamp(comment.createdAt);
  if (parsedCreatedAt._tag === "err") return undefined;
  const parsed: MutableGitHubComment = {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: parsedCreatedAt.value,
  };
  if (comment.updatedAt !== undefined) {
    const parsedUpdatedAt = parseIsoTimestamp(comment.updatedAt);
    if (parsedUpdatedAt._tag === "ok") parsed.updatedAt = parsedUpdatedAt.value;
  }
  if (comment.url !== undefined) parsed.url = comment.url;
  if (comment.authorAvatarDataUri !== undefined)
    parsed.authorAvatarDataUri = comment.authorAvatarDataUri;
  // `location` is intentionally not carried through: a location-less
  // GeneralThread's comments never have one, and ConversationThreadCard
  // doesn't read it.
  if (comment.viewerDidAuthor !== undefined)
    parsed.viewerDidAuthor = comment.viewerDidAuthor;
  return parsed;
}

function ConversationTimelineEntry({
  entry,
  generalThreadOverrides,
}: {
  readonly entry: WorkbenchResponse["conversation"]["entries"][number];
  readonly generalThreadOverrides: GeneralThreadOverrides;
}): React.JSX.Element | null {
  switch (entry._tag) {
    case "PrDescription":
      // Pull request descriptions are rendered separately above the
      // timeline (see `conversation.prDescription`); this tag never
      // actually appears inside `conversation.entries`.
      return null;
    case "IssueComment":
      // SAFETY: the wire comment schema validates `createdAt`/`updatedAt`
      // as ISO timestamps and otherwise matches `GitHubComment` field for
      // field, plus optional wire-only fields `GitHubComment` doesn't need.
      return <IssueCommentEntry comment={entry.comment as GitHubComment} />;
    case "ReviewSummary":
      // SAFETY: the wire review schema validates `submittedAt` as an ISO
      // timestamp and otherwise matches `PublishedReview` field for field.
      return <ReviewSummaryEntry review={entry.review as PublishedReview} />;
    case "GeneralThread":
      return (
        <GeneralThreadEntry
          wire={entry.thread}
          overrides={generalThreadOverrides}
        />
      );
  }
}

function IssueCommentEntry({
  comment,
}: {
  readonly comment: GitHubComment;
}): React.JSX.Element {
  return (
    <div className="flex gap-3 border-b py-3">
      <Avatar name={comment.author} dataUri={comment.authorAvatarDataUri} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold">{comment.author}</span>
          <span className="text-[11px] text-muted-foreground">
            {comment.createdAt}
          </span>
        </div>
        <div className="mt-1 text-sm leading-6">
          <PullRequestDescriptionPreview markdown={comment.body} />
        </div>
      </div>
    </div>
  );
}

function ReviewSummaryEntry({
  review,
}: {
  readonly review: PublishedReview;
}): React.JSX.Element {
  const verdictLabel =
    review.event === "APPROVED"
      ? "Approved"
      : review.event === "CHANGES_REQUESTED"
        ? "Changes requested"
        : review.event === "DISMISSED"
          ? "Dismissed"
          : "Commented";
  return (
    <div className="flex gap-3 border-b py-3">
      {/* `PublishedReview.author` is a plain string with no avatar field,
          so this always renders the initials fallback rather than a
          cached image. */}
      <Avatar name={review.author} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold">{review.author}</span>
          <span className="text-[11px] text-muted-foreground">
            {review.submittedAt}
          </span>
          <Badge variant="outline" className="text-[10px]">
            {verdictLabel}
          </Badge>
        </div>
        {review.body.length > 0 && (
          <div className="mt-1 text-sm leading-6">
            <PullRequestDescriptionPreview markdown={review.body} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Mutable draft of `ConversationThreadCardData`, built in statements below
 * so each optional callback is added only when its action is wired, instead
 * of a conditional empty-object spread. */
type MutableConversationThreadCardData = {
  -readonly [K in keyof ConversationThreadCardData]: ConversationThreadCardData[K];
};

/**
 * Renders a location-less "general" review thread through the same
 * `ConversationThreadCard` used by the diff view, so Reply/Resolve/Edit/
 * Delete behave identically on both surfaces. Falls back to read-only when
 * no actions are wired in (`overrides` callbacks all undefined).
 *
 * Never hides content on a parse failure:
 * - A comment whose timestamp fails to parse is dropped from the rendered
 *   list, but the thread is marked `complete: false` so the card's existing
 *   "Some replies unavailable" affordance fires — the same signal
 *   `review-diff-view.tsx` uses for a partial thread page.
 * - A thread whose id fails `parseGitHubThreadId` still renders with its
 *   comments and Edit/Delete (which key on each comment's own id, not the
 *   thread id); only Reply/Resolve are withheld, since those are the only
 *   actions that genuinely require the branded `GitHubThreadId`.
 */
function GeneralThreadEntry({
  wire,
  overrides,
}: {
  readonly wire: WireGeneralThread;
  readonly overrides: GeneralThreadOverrides;
}): React.JSX.Element {
  const parsedThreadId = parseGitHubThreadId(wire.id);
  const parsedComments = wire.comments.flatMap((comment) => {
    const parsed = parseGeneralThreadComment(comment);
    return parsed === undefined ? [] : [parsed];
  });
  const someCommentsDropped = parsedComments.length < wire.comments.length;
  const state =
    parsedThreadId._tag === "ok"
      ? (overrides.resolvedThreads.get(parsedThreadId.value) ?? wire.state)
      : wire.state;
  const comments = parsedComments.flatMap((comment) => {
    if (overrides.deletedCommentIds.has(comment.id)) return [];
    const body = overrides.editedBodies.get(comment.id);
    return [body === undefined ? comment : { ...comment, body }];
  });
  const target: ConversationThreadTarget =
    parsedThreadId._tag === "ok"
      ? { _tag: "thread", id: parsedThreadId.value }
      : { _tag: "unresolved" };
  const cardData: MutableConversationThreadCardData = {
    target,
    state,
    comments,
  };
  // A dropped comment always forces `complete: false` (ORed with the wire's
  // own value) so the "Some replies unavailable" notice fires even when the
  // wire otherwise reported this thread as fully loaded.
  if (someCommentsDropped) cardData.complete = false;
  else if (wire.complete !== undefined) cardData.complete = wire.complete;
  // Reply/Resolve require the branded thread id; withhold them entirely
  // (rather than wiring a handler that would silently no-op) when the id
  // failed to parse.
  if (parsedThreadId._tag === "ok") {
    if (overrides.onSetState !== undefined)
      cardData.onSetState = overrides.onSetState;
    if (overrides.onReply !== undefined) cardData.onReply = overrides.onReply;
  }
  // Edit/Delete key on each comment's own id, not the thread id, so they
  // stay available even when the thread id itself is unresolved.
  if (overrides.onEditComment !== undefined)
    cardData.onEditComment = overrides.onEditComment;
  if (overrides.onDeleteComment !== undefined)
    cardData.onDeleteComment = overrides.onDeleteComment;
  return <ConversationThreadCard thread={cardData} />;
}
