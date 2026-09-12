import { describe, expect, it } from "vitest";

import { unionRecentWrites } from "../../src/domain/recent-review-write";

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
});
