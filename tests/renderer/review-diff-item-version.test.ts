import { describe, expect, it } from "vitest";

import { reviewDiffItemVersion } from "../../src/renderer/src/review-diff-item-version";

describe("reviewDiffItemVersion", () => {
  it("changes Pierre's controlled item revision when source hydration replaces a partial diff", () => {
    expect(reviewDiffItemVersion({ collapsed: false, hydrated: false })).toBe(0);
    expect(reviewDiffItemVersion({ collapsed: false, hydrated: true })).toBe(2);
  });

  it("keeps file-collapse and hydration changes independently observable", () => {
    expect(reviewDiffItemVersion({ collapsed: true, hydrated: false })).toBe(1);
    expect(reviewDiffItemVersion({ collapsed: true, hydrated: true })).toBe(3);
  });

  it("changes the item revision when rendered annotation placement changes", () => {
    const withoutAnnotation = reviewDiffItemVersion({ collapsed: false, hydrated: false });
    const firstPlacement = reviewDiffItemVersion({
      collapsed: false,
      hydrated: false,
      annotationKey: "local-comment:src/a.ts:1:1:deletions",
    });
    const secondPlacement = reviewDiffItemVersion({
      collapsed: false,
      hydrated: false,
      annotationKey: "local-comment:src/a.ts:2:2:deletions",
    });

    expect(firstPlacement).not.toBe(withoutAnnotation);
    expect(secondPlacement).not.toBe(firstPlacement);
  });
});
