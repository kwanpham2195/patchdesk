import { describe, expect, it } from "vitest";

import {
  parseAssigneeReceipt,
  parseDirectConversationReceipt,
  parseLabelReceipt,
  parseReviewerReceipt,
} from "../../src/renderer/src/flows/review-workbench-receipts";

describe("review workbench receipt parsers", () => {
  it("parses direct conversation receipts and validates thread IDs", () => {
    expect(
      parseDirectConversationReceipt({
        _tag: "CommentCreated",
        commentId: "comment-1",
        reviewId: "review-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      _tag: "CommentCreated",
      commentId: "comment-1",
      reviewId: "review-1",
      threadId: "thread-1",
    });
    expect(
      parseDirectConversationReceipt({
        _tag: "ThreadStateChanged",
        threadId: "thread-1",
        state: "resolved",
      }),
    ).toMatchObject({ _tag: "ThreadStateChanged", state: "resolved" });
    expect(
      parseDirectConversationReceipt({
        _tag: "ThreadStateChanged",
        threadId: "",
        state: "open",
      }),
    ).toBeUndefined();
  });

  it("rejects malformed direct conversation receipts", () => {
    expect(parseDirectConversationReceipt(undefined)).toBeUndefined();
    expect(
      parseDirectConversationReceipt({
        _tag: "CommentCreated",
        commentId: "",
      }),
    ).toBeUndefined();
    expect(
      parseDirectConversationReceipt({
        _tag: "Unknown",
        commentId: "comment-1",
      }),
    ).toBeUndefined();
  });

  it("parses metadata receipts and keeps their item arrays", () => {
    expect(
      parseLabelReceipt({ _tag: "LabelsAdded", added: ["bug", "urgent"] }),
    ).toEqual({ _tag: "LabelsAdded", added: ["bug", "urgent"] });
    expect(
      parseAssigneeReceipt({
        _tag: "AssigneesRemoved",
        removed: ["octocat"],
      }),
    ).toEqual({ _tag: "AssigneesRemoved", removed: ["octocat"] });
    expect(
      parseReviewerReceipt({
        _tag: "ReviewersRequested",
        requested: ["octocat"],
      }),
    ).toEqual({ _tag: "ReviewersRequested", requested: ["octocat"] });
  });

  it("rejects malformed metadata receipts", () => {
    expect(
      parseLabelReceipt({ _tag: "LabelsAdded", added: "bug" }),
    ).toBeUndefined();
    expect(
      parseAssigneeReceipt({ _tag: "AssigneesRemoved", removed: [1] }),
    ).toBeUndefined();
    expect(parseReviewerReceipt(null)).toBeUndefined();
  });
});
