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
});
