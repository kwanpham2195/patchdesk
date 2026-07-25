import { describe, expect, it } from "vitest";

import { activeFilePathAtScrollTop } from "../../src/renderer/src/review-diff-active-file";

describe("activeFilePathAtScrollTop", () => {
  it("keeps the first file active until the next file reaches the viewport top", () => {
    const items = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const tops = new Map([
      ["first", 0],
      ["second", 240],
      ["third", 520],
    ]);

    expect(
      activeFilePathAtScrollTop(items, 239, (id) => tops.get(id)),
    ).toBe("first");
  });

  it("switches to the next file exactly at its top", () => {
    const items = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const tops = new Map([
      ["first", 0],
      ["second", 240],
      ["third", 520],
    ]);

    expect(
      activeFilePathAtScrollTop(items, 240, (id) => tops.get(id)),
    ).toBe("second");
  });

  it("skips files without usable metrics", () => {
    const items = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const tops = new Map([
      ["second", 180],
    ]);

    expect(
      activeFilePathAtScrollTop(items, 200, (id) => tops.get(id)),
    ).toBe("second");
  });

  it("returns undefined for empty items", () => {
    expect(activeFilePathAtScrollTop([], 120, () => undefined)).toBeUndefined();
  });

  it("keeps the first ordered item when metrics share a top", () => {
    expect(
      activeFilePathAtScrollTop(
        [{ id: "first" }, { id: "second" }],
        100,
        () => 100,
      ),
    ).toBe("first");
  });
});
