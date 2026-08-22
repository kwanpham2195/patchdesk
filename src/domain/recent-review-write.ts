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
