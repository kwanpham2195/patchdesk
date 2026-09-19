import { describe, expect, it } from "vitest";

import { parseGitHubThreadId } from "../../src/domain/ids";
import {
  appendRecentWriteReceipts,
  parseRecentReviewWrite,
  unionRecentWrites,
  type RecentReviewWrite,
} from "../../src/domain/recent-review-write";

const threadId = parseGitHubThreadId("PRRT_thread");
if (threadId._tag === "err") throw new Error("invalid fixture");
const otherThreadId = parseGitHubThreadId("PRRT_other");
if (otherThreadId._tag === "err") throw new Error("invalid fixture");

describe("appendRecentWriteReceipts", () => {
  it("drops only the pending receipt for the thread the discard removed", () => {
    expect(
      appendRecentWriteReceipts(
        [
          { _tag: "PendingThread", threadId: threadId.value },
          { _tag: "PendingThread", threadId: otherThreadId.value },
        ],
        [{ _tag: "DiscardedThread", threadId: threadId.value }],
      ),
    ).toEqual([
      { _tag: "PendingThread", threadId: otherThreadId.value },
      { _tag: "DiscardedThread", threadId: threadId.value },
    ]);
  });

  it("drops the create receipt for a comment the same session deleted, in either id space", () => {
    expect(
      appendRecentWriteReceipts<RecentReviewWrite>(
        [
          { _tag: "Comment", commentId: "2145998877" },
          { _tag: "Comment", commentId: "PRRC_reply" },
          { _tag: "Comment", commentId: "PRRC_other" },
        ],
        [
          {
            _tag: "DeletedComment",
            commentId: "2145998877",
            nodeId: "PRRC_created",
          },
          { _tag: "DeletedComment", commentId: "PRRC_reply" },
        ],
      ),
    ).toEqual([
      { _tag: "Comment", commentId: "PRRC_other" },
      {
        _tag: "DeletedComment",
        commentId: "2145998877",
        nodeId: "PRRC_created",
      },
      { _tag: "DeletedComment", commentId: "PRRC_reply" },
    ]);
  });

  it("drops the create receipt a delete names only by node id", () => {
    expect(
      appendRecentWriteReceipts<RecentReviewWrite>(
        [{ _tag: "Comment", commentId: "PRRC_created" }],
        [
          {
            _tag: "DeletedComment",
            commentId: "2145998877",
            nodeId: "PRRC_created",
          },
        ],
      ),
    ).toEqual([
      {
        _tag: "DeletedComment",
        commentId: "2145998877",
        nodeId: "PRRC_created",
      },
    ]);
  });
});

describe("unionRecentWrites", () => {
  it("dedupes a LabelChange entry the durable journal and the request both carry", () => {
    // Exercises recentWriteDedupeKey's LabelChange case: missing it would let
    // an identical durable+requested pair through as two entries.
    expect(
      unionRecentWrites(
        [{ _tag: "LabelChange", added: ["bug"], removed: [] }],
        [{ _tag: "LabelChange", added: ["bug"], removed: [] }],
      ),
    ).toEqual([{ _tag: "LabelChange", added: ["bug"], removed: [] }]);
  });

  it("keys a DraftStateChange by the state it left behind", () => {
    expect(
      unionRecentWrites(
        [{ _tag: "DraftStateChange", draft: false }],
        [
          { _tag: "DraftStateChange", draft: false },
          { _tag: "DraftStateChange", draft: true },
        ],
      ),
    ).toEqual([
      { _tag: "DraftStateChange", draft: false },
      { _tag: "DraftStateChange", draft: true },
    ]);
  });

  it("keys a BaseBranchChange by the branch it left behind", () => {
    expect(
      unionRecentWrites(
        [{ _tag: "BaseBranchChange", branch: "main" }],
        [
          { _tag: "BaseBranchChange", branch: "main" },
          { _tag: "BaseBranchChange", branch: "release/1.2" },
        ],
      ),
    ).toEqual([
      { _tag: "BaseBranchChange", branch: "main" },
      { _tag: "BaseBranchChange", branch: "release/1.2" },
    ]);
  });
});

describe("parseRecentReviewWrite", () => {
  it("rejects a thread receipt whose thread id is not a GitHub thread id", () => {
    expect(
      parseRecentReviewWrite({
        _tag: "PendingThread",
        threadId: "not a thread",
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidRecentReviewWrite" } });
  });

  it("brands a DiscardedThread receipt as its own variant", () => {
    expect(
      parseRecentReviewWrite({
        _tag: "DiscardedThread",
        threadId: "PRRT_discarded",
      }),
    ).toEqual({
      _tag: "ok",
      value: { _tag: "DiscardedThread", threadId: "PRRT_discarded" },
    });
  });
});
