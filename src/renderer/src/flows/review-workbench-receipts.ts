import * as v from "valibot";

import type { RawJsonValue } from "../../../domain/json";
import { definedProps } from "../../../domain/defined-props";
import { parseGitHubThreadId, type GitHubThreadId } from "../../../domain/ids";

export type DirectConversationReceipt =
  | {
      readonly _tag: "CommentCreated";
      readonly commentId: string;
      readonly reviewId?: string;
      readonly threadId?: string;
    }
  | {
      readonly _tag: "ReplyCreated";
      readonly commentId: string;
      readonly reviewId?: string;
    }
  | {
      readonly _tag: "ThreadStateChanged";
      readonly threadId: GitHubThreadId;
      readonly state: "open" | "resolved";
    }
  | { readonly _tag: "CommentEdited"; readonly commentId: string }
  | { readonly _tag: "CommentDeleted"; readonly commentId: string };

const directConversationReceiptSchema = v.variant("_tag", [
  v.looseObject({
    _tag: v.literal("CommentCreated"),
    commentId: v.pipe(v.string(), v.minLength(1)),
    reviewId: v.optional(v.pipe(v.string(), v.minLength(1))),
    threadId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.looseObject({
    _tag: v.literal("ReplyCreated"),
    commentId: v.pipe(v.string(), v.minLength(1)),
    reviewId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.looseObject({
    _tag: v.literal("ThreadStateChanged"),
    threadId: v.string(),
    state: v.picklist(["open", "resolved"]),
  }),
  v.looseObject({
    _tag: v.literal("CommentEdited"),
    commentId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.looseObject({
    _tag: v.literal("CommentDeleted"),
    commentId: v.pipe(v.string(), v.minLength(1)),
  }),
]);

export function parseDirectConversationReceipt(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for the direct-conversation command response; there is no earlier boundary to run it at.
  value: unknown,
): DirectConversationReceipt | undefined {
  const parsed = v.safeParse(directConversationReceiptSchema, value);
  if (!parsed.success) return undefined;
  const output = parsed.output;
  if (output._tag === "ThreadStateChanged") {
    const threadId = parseGitHubThreadId(output.threadId);
    return threadId._tag === "err"
      ? undefined
      : {
          _tag: "ThreadStateChanged",
          threadId: threadId.value,
          state: output.state,
        };
  }
  if (output._tag === "CommentEdited" || output._tag === "CommentDeleted")
    return { _tag: output._tag, commentId: output.commentId };
  if (output._tag === "ReplyCreated")
    return {
      _tag: "ReplyCreated",
      commentId: output.commentId,
      ...definedProps({ reviewId: output.reviewId }),
    };
  return {
    _tag: "CommentCreated",
    commentId: output.commentId,
    ...definedProps({
      reviewId: output.reviewId,
      threadId: output.threadId,
    }),
  };
}

const labelReceiptSchema = v.variant("_tag", [
  v.looseObject({
    _tag: v.literal("LabelsAdded"),
    added: v.array(v.string()),
  }),
  v.looseObject({
    _tag: v.literal("LabelsRemoved"),
    removed: v.array(v.string()),
  }),
]);

export type LabelReceipt =
  | { readonly _tag: "LabelsAdded"; readonly added: ReadonlyArray<string> }
  | {
      readonly _tag: "LabelsRemoved";
      readonly removed: ReadonlyArray<string>;
    };

export function parseLabelReceipt(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for the labels command response; there is no earlier boundary to run it at.
  value: unknown,
): LabelReceipt | undefined {
  const parsed = v.safeParse(labelReceiptSchema, value);
  return parsed.success ? parsed.output : undefined;
}

const assigneeReceiptSchema = v.variant("_tag", [
  v.looseObject({
    _tag: v.literal("AssigneesAdded"),
    added: v.array(v.string()),
  }),
  v.looseObject({
    _tag: v.literal("AssigneesRemoved"),
    removed: v.array(v.string()),
  }),
]);

export type AssigneeReceipt =
  | { readonly _tag: "AssigneesAdded"; readonly added: ReadonlyArray<string> }
  | {
      readonly _tag: "AssigneesRemoved";
      readonly removed: ReadonlyArray<string>;
    };

export function parseAssigneeReceipt(
  value: RawJsonValue | undefined,
): AssigneeReceipt | undefined {
  const parsed = v.safeParse(assigneeReceiptSchema, value);
  return parsed.success ? parsed.output : undefined;
}

const reviewerReceiptSchema = v.variant("_tag", [
  v.looseObject({
    _tag: v.literal("ReviewersRequested"),
    requested: v.array(v.string()),
  }),
  v.looseObject({
    _tag: v.literal("ReviewersRemoved"),
    removed: v.array(v.string()),
  }),
]);

export type ReviewerReceipt =
  | {
      readonly _tag: "ReviewersRequested";
      readonly requested: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "ReviewersRemoved";
      readonly removed: ReadonlyArray<string>;
    };

export function parseReviewerReceipt(
  value: RawJsonValue | undefined,
): ReviewerReceipt | undefined {
  const parsed = v.safeParse(reviewerReceiptSchema, value);
  return parsed.success ? parsed.output : undefined;
}
