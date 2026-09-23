import { describe, expect, it } from "vitest";

import { reviewDiffItemVersion } from "../../src/renderer/src/review-diff-item-version";

describe("reviewDiffItemVersion", () => {
  it("assigns a distinct revision to every collapsed and hydrated state", () => {
    const states = [
      { collapsed: false, hydrated: false },
      { collapsed: false, hydrated: true },
      { collapsed: true, hydrated: false },
      { collapsed: true, hydrated: true },
    ] as const;
    const versions = states.map((state) => reviewDiffItemVersion(state));

    expect(new Set(versions).size).toBe(states.length);
  });

  it("changes the item revision when rendered annotation placement changes", () => {
    const withoutAnnotation = reviewDiffItemVersion({
      collapsed: false,
      hydrated: false,
    });
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
