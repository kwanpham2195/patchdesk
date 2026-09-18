import type {
  Conversation,
  ConversationEntry,
  GitHubComments,
  GitHubPublishedFeedback,
} from "../../domain/github-context";
import { casesHandled } from "../../domain/result";

/**
 * Orders one Conversation timeline: every published review summary, every
 * published review comment, every plain issue comment, and the review threads
 * GitHub returned with no code anchor. Threads that DO carry a `location` are deliberately absent —
 * they belong to `Conversation.inline` and are placed against the diff
 * instead (ADR 0028, "Show only conversation threads the diff can place"), so
 * the caller owns that split and this function owns the timeline.
 *
 * The real adapter and `FakeGitHubAdapter` share this ordering so a fixture
 * timeline cannot drift from the one GitHub produces.
 */
export function assembleConversationEntries(
  feedback: GitHubPublishedFeedback,
  comments: GitHubComments,
): ReadonlyArray<ConversationEntry> {
  const entries: ConversationEntry[] = [
    ...feedback.reviews.map((review) => ({
      _tag: "ReviewSummary" as const,
      review,
    })),
    ...feedback.comments.map((comment) => ({
      _tag: "ReviewComment" as const,
      comment,
    })),
    ...feedback.issueComments.map((comment) => ({
      _tag: "IssueComment" as const,
      comment,
    })),
    ...comments.threads
      .filter((thread) => thread.location === undefined)
      .map((thread) => ({ _tag: "GeneralThread" as const, thread })),
  ];
  return entries.sort((a, b) =>
    conversationEntryOrder(a).localeCompare(conversationEntryOrder(b)),
  );
}

/**
 * Splits one loaded pull request into its two conversation halves: the
 * timeline `assembleConversationEntries` orders, and the anchored threads the
 * diff places (ADR 0028).
 *
 * It takes already-read inputs rather than reading GitHub itself, so a caller
 * that has just fetched the pull request, its comments, and its published
 * feedback assembles from what it holds instead of re-running those reads.
 */
export function assembleConversation(
  prDescription: string,
  feedback: GitHubPublishedFeedback,
  comments: GitHubComments,
): Conversation {
  let inline: GitHubComments = {
    threads: comments.threads.filter((thread) => thread.location !== undefined),
  };
  if (comments.complete !== undefined)
    inline = { ...inline, complete: comments.complete };
  if (comments.incompleteReason !== undefined)
    inline = { ...inline, incompleteReason: comments.incompleteReason };
  return {
    prDescription,
    entries: assembleConversationEntries(feedback, comments),
    inline,
    complete: feedback.complete !== false && comments.complete !== false,
  };
}

/** The empty published feedback a caller assembles with when no feedback read is wired. */
export const noPublishedFeedback: GitHubPublishedFeedback = {
  reviews: [],
  comments: [],
  issueComments: [],
};

/**
 * The timestamp each entry kind is stamped with; an undated entry sorts as
 * `""`, ahead of everything dated.
 */
function conversationEntryOrder(entry: ConversationEntry): string {
  switch (entry._tag) {
    case "ReviewSummary":
      return entry.review.submittedAt;
    case "IssueComment":
    case "ReviewComment":
      return entry.comment.createdAt;
    case "GeneralThread":
      return entry.thread.comments[0]?.createdAt ?? "";
    case "PrDescription":
      return "";
    default:
      return casesHandled(entry);
  }
}
