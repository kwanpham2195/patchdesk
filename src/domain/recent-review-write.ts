import * as v from "valibot";

import { parseGitHubThreadId, type GitHubThreadId } from "./ids";
import { err, ok, type Result } from "./result";

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
    }
  | { readonly _tag: "DraftStateChange"; readonly draft: boolean };

/** Failure to decode a serialized receipt into a `RecentReviewWrite`. */
export type InvalidRecentReviewWrite = {
  readonly _tag: "InvalidRecentReviewWrite";
};

/**
 * The domain owns the serialized receipt because the detect-updates body, the
 * recent-write journal entry, and the write operation record are the same
 * shape and must not drift apart.
 */
export const recentReviewWriteRecordSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("Comment"),
    commentId: v.pipe(v.string(), v.minLength(1)),
    reviewId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    _tag: v.literal("ThreadState"),
    threadId: v.pipe(v.string(), v.minLength(1)),
    state: v.picklist(["open", "resolved"]),
  }),
  v.strictObject({
    _tag: v.literal("PendingThread"),
    threadId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("DirectSummaryReview"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    _tag: v.literal("LabelChange"),
    added: v.pipe(v.array(v.string()), v.readonly()),
    removed: v.pipe(v.array(v.string()), v.readonly()),
  }),
  v.strictObject({
    _tag: v.literal("AssigneeChange"),
    added: v.pipe(v.array(v.string()), v.readonly()),
    removed: v.pipe(v.array(v.string()), v.readonly()),
  }),
  v.strictObject({
    _tag: v.literal("ReviewerChange"),
    requested: v.pipe(v.array(v.string()), v.readonly()),
    removed: v.pipe(v.array(v.string()), v.readonly()),
  }),
  v.strictObject({ _tag: v.literal("DraftStateChange"), draft: v.boolean() }),
]);

/** A schema-validated serialized receipt whose branded ids are not yet parsed. */
export type RecentReviewWriteRecord = v.InferOutput<
  typeof recentReviewWriteRecordSchema
>;

type AssertNever<T extends never> = T;

/**
 * Fails to compile when `RecentReviewWrite` gains a member that
 * `recentReviewWriteRecordSchema` omits.
 *
 * @public Nothing imports this; the compiler is its only reader.
 */
export type UnserializableRecentReviewWrite = AssertNever<
  Exclude<RecentReviewWrite, RecentReviewWriteRecord>
>;

/**
 * Brand a schema-validated receipt; the declared return type rejects a schema
 * member without a branch, so a new tag cannot be read as another one.
 */
export function parseRecentReviewWrite(
  record: RecentReviewWriteRecord,
): Result<RecentReviewWrite, InvalidRecentReviewWrite> {
  switch (record._tag) {
    case "Comment":
      return ok(
        record.reviewId === undefined
          ? { _tag: "Comment", commentId: record.commentId }
          : {
              _tag: "Comment",
              commentId: record.commentId,
              reviewId: record.reviewId,
            },
      );
    case "ThreadState": {
      const threadId = parseGitHubThreadId(record.threadId);
      return threadId._tag === "err"
        ? invalidRecentReviewWrite()
        : ok({
            _tag: "ThreadState",
            threadId: threadId.value,
            state: record.state,
          });
    }
    case "PendingThread": {
      const threadId = parseGitHubThreadId(record.threadId);
      return threadId._tag === "err"
        ? invalidRecentReviewWrite()
        : ok({ _tag: "PendingThread", threadId: threadId.value });
    }
    case "DirectSummaryReview":
    case "LabelChange":
    case "AssigneeChange":
    case "ReviewerChange":
    case "DraftStateChange":
      return ok(record);
  }
}

function invalidRecentReviewWrite(): Result<never, InvalidRecentReviewWrite> {
  return err({ _tag: "InvalidRecentReviewWrite" });
}

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
    case "DraftStateChange":
      // The whole write is the state it left behind, so two toggles to the
      // same state are the same write.
      return `DraftStateChange:${entry.draft}`;
  }
}
