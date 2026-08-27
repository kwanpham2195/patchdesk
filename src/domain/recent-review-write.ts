import type { GitHubThreadId } from "./ids";

/** A GitHub write made by this app that detection must exclude from remote changes. */
export type RecentReviewWrite =
  | {
      readonly _tag: "Comment";
      readonly commentId: string;
      readonly reviewId?: string;
    }
  | {
      readonly _tag: "ThreadState";
      readonly threadId: GitHubThreadId;
      readonly state: "open" | "resolved";
    }
  | {
      readonly _tag: "PendingThread";
      readonly threadId: GitHubThreadId;
    }
  | {
      readonly _tag: "DirectSummaryReview";
      readonly reviewId: string;
    }
  | {
      readonly _tag: "LabelChange";
      readonly added: ReadonlyArray<string>;
      readonly removed: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "AssigneeChange";
      readonly added: ReadonlyArray<string>;
      readonly removed: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "ReviewerChange";
      readonly requested: ReadonlyArray<string>;
      readonly removed: ReadonlyArray<string>;
    };

/**
 * Combine the durable own-write journal with a caller-supplied array (a
 * renderer's optimistic in-memory writes, or a request-supplied list).
 * Duplicates are harmless to a set-based journal lookup, but de-duplicating
 * keeps the union from growing needlessly.
 */
export function unionRecentWrites(
  durable: ReadonlyArray<RecentReviewWrite>,
  requested: ReadonlyArray<RecentReviewWrite>,
): ReadonlyArray<RecentReviewWrite> {
  const seen = new Set<string>();
  const union: Array<RecentReviewWrite> = [];
  for (const entry of [...durable, ...requested]) {
    const key = recentWriteDedupeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(entry);
  }
  return union;
}

function recentWriteDedupeKey(entry: RecentReviewWrite): string {
  switch (entry._tag) {
    case "Comment":
      return `Comment:${entry.commentId}`;
    case "ThreadState":
      return `ThreadState:${entry.threadId}:${entry.state}`;
    case "PendingThread":
      return `PendingThread:${entry.threadId}`;
    case "DirectSummaryReview":
      return `DirectSummaryReview:${entry.reviewId}`;
    case "LabelChange":
      // Two label writes are the same write only if they touched the exact
      // same label names; sort so key order doesn't depend on call order.
      return `LabelChange:${[...entry.added].sort().join(",")}:${[...entry.removed].sort().join(",")}`;
    case "AssigneeChange":
      // Mirrors LabelChange: two assignee writes are the same write only if
      // they touched the exact same logins.
      return `AssigneeChange:${[...entry.added].sort().join(",")}:${[...entry.removed].sort().join(",")}`;
    case "ReviewerChange":
      // Mirrors AssigneeChange: two reviewer writes are the same write only
      // if they touched the exact same logins.
      return `ReviewerChange:${[...entry.requested].sort().join(",")}:${[...entry.removed].sort().join(",")}`;
  }
}
