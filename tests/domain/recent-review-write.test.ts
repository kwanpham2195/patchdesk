import { describe, expect, it } from "vitest";

import {
  parseRecentReviewWrite,
  unionRecentWrites,
} from "../../src/domain/recent-review-write";

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
});
