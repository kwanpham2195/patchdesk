import { casesHandled } from "./result";

/**
 * The structural shape shared by the domain `ConversationEntry` and the
 * renderer's parsed copy, so both sides compare entries by one rule.
 */
type TimestampedConversationEntry<Timestamp extends string> =
  | { readonly _tag: "PrDescription" }
  | {
      readonly _tag: "IssueComment" | "ReviewComment";
      readonly comment: { readonly createdAt: Timestamp };
    }
  | {
      readonly _tag: "ReviewSummary";
      readonly review: { readonly submittedAt: Timestamp };
    }
  | {
      readonly _tag: "GeneralThread";
      readonly thread: {
        readonly comments: ReadonlyArray<{ readonly createdAt: Timestamp }>;
      };
    };

/**
 * GitHub's time for one Conversation entry: a thread counts from its newest
 * reply, so a reply makes the thread new. The description has no time.
 * Timestamps share `isoTimestampSyntax`, so string order is time order.
 */
export function conversationEntryTimestamp<Timestamp extends string>(
  entry: TimestampedConversationEntry<Timestamp>,
): Timestamp | undefined {
  switch (entry._tag) {
    case "PrDescription":
      return undefined;
    case "IssueComment":
    case "ReviewComment":
      return entry.comment.createdAt;
    case "ReviewSummary":
      return entry.review.submittedAt;
    case "GeneralThread":
      return newestTimestamp(
        entry.thread.comments.map((comment) => comment.createdAt),
      );
    default:
      return casesHandled(entry);
  }
}

/** The newest entry time in a Conversation, or undefined when none has one. */
export function newestConversationTimestamp<Timestamp extends string>(
  entries: ReadonlyArray<TimestampedConversationEntry<Timestamp>>,
): Timestamp | undefined {
  return newestTimestamp(entries.map(conversationEntryTimestamp));
}

function newestTimestamp<Timestamp extends string>(
  timestamps: ReadonlyArray<Timestamp | undefined>,
): Timestamp | undefined {
  let newest: Timestamp | undefined;
  for (const timestamp of timestamps)
    if (timestamp !== undefined && (newest === undefined || timestamp > newest))
      newest = timestamp;
  return newest;
}
