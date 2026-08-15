import { PullRequestDescriptionPreview } from "./pull-request-description";
import type {
  GitHubComment,
  GitHubConversationThread,
  PublishedReview,
} from "../../../domain/github-context";
import type { WorkbenchResponse } from "../renderer-contracts";
import { Badge } from "./ui/badge";

export function Conversation({
  conversation,
}: {
  readonly conversation: WorkbenchResponse["conversation"];
}): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto" data-review-conversation>
      <div className="mx-auto max-w-[680px] px-4 py-4">
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
              />
            ))
          )}
        </div>

        {conversation.complete === false && (
          <p className="mt-4 text-xs text-muted-foreground">
            Some conversation was not loaded. Refresh GitHub state to load more.
          </p>
        )}
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

function ConversationTimelineEntry({
  entry,
}: {
  readonly entry: WorkbenchResponse["conversation"]["entries"][number];
}): React.JSX.Element {
  switch (entry._tag) {
    case "PrDescription":
      return null as unknown as React.JSX.Element;
    case "IssueComment":
      return <IssueCommentEntry comment={entry.comment as GitHubComment} />;
    case "ReviewSummary":
      return <ReviewSummaryEntry review={entry.review as PublishedReview} />;
    case "GeneralThread":
      return (
        <GeneralThreadEntry
          thread={entry.thread as unknown as GitHubConversationThread}
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
    <div className="border-b py-3">
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
    <div className="border-b py-3">
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
  );
}

function GeneralThreadEntry({
  thread,
}: {
  readonly thread: GitHubConversationThread;
}): React.JSX.Element {
  return (
    <div className="border-b py-3">
      <div className="flex items-center gap-2 mb-1">
        <Badge variant="outline" className="text-[10px]">
          {thread.state === "outdated"
            ? "Outdated"
            : thread.state === "resolved"
              ? "Resolved"
              : "Open"}
        </Badge>
      </div>
      {thread.comments.map((comment, index) => (
        <div
          key={comment.id}
          className={index > 0 ? "ml-4 border-l-2 border-border pl-3 mt-2" : ""}
        >
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
      ))}
    </div>
  );
}
