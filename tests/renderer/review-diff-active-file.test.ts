import { describe, expect, it } from "vitest";

import {
  activeFilePathAtScrollTop,
  type ActiveFileViewport,
} from "../../src/renderer/src/review-diff-active-file";

// A generous viewport/content pair that makes every item in these tests
// reachable (top <= contentHeight - viewportHeight), so the common,
// strict-top-of-viewport path is exercised unchanged from before the
// unreachable-item fix below.
function viewport(scrollTop: number): ActiveFileViewport {
  return { scrollTop, viewportHeight: 400, contentHeight: 4_000 };
}

describe("activeFilePathAtScrollTop", () => {
  it("keeps the first file active until the next file reaches the viewport top", () => {
    const items = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const tops = new Map([
      ["first", 0],
      ["second", 240],
      ["third", 520],
    ]);

    expect(
      activeFilePathAtScrollTop(items, viewport(239), (id) => tops.get(id)),
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
      activeFilePathAtScrollTop(items, viewport(240), (id) => tops.get(id)),
    ).toBe("second");
  });

  it("skips files without usable metrics", () => {
    const items = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const tops = new Map([["second", 180]]);

    expect(
      activeFilePathAtScrollTop(items, viewport(200), (id) => tops.get(id)),
    ).toBe("second");
  });

  it("returns undefined for empty items", () => {
    expect(
      activeFilePathAtScrollTop([], viewport(120), () => undefined),
    ).toBeUndefined();
  });

  it("keeps the first ordered item when metrics share a top", () => {
    expect(
      activeFilePathAtScrollTop(
        [{ id: "first" }, { id: "second" }],
        viewport(100),
        () => 100,
      ),
    ).toBe("first");
  });

  it("selects a file living in the final viewport-height of content, which strict top-of-viewport semantics can never reach", () => {
    // Measured on the #workbench-fixture browser fixture (last file
    // src/b.ts is 1 line long): getTopForItem("src/b.ts") = 1988, the
    // settled scrollTop after a `.` jump clamps at 1438 (it cannot scroll
    // any higher), codeView scrollHeight 2150, .review-diff-viewport
    // scrollHeight 2166, clientHeight 650. src/b.ts's top (1988) exceeds
    // maxScrollTop (2166 - 650 = 1516), so it can never satisfy
    // `top <= scrollTop` -- it must become active on visibility instead.
    const items = [{ id: "a" }, { id: "b" }];
    const tops = new Map([
      ["a", 0],
      ["b", 1988],
    ]);

    expect(
      activeFilePathAtScrollTop(
        items,
        { scrollTop: 1438, viewportHeight: 650, contentHeight: 2166 },
        (id) => tops.get(id),
      ),
    ).toBe("b");
  });

  it("does not select a reachable file early just because it is visible", () => {
    // File at top 1000 with plenty of content below it (maxScrollTop is far
    // past 1000), so it is normally reachable and must keep strict
    // top-of-viewport semantics: being visible near the bottom of the
    // viewport is not enough, the highlight must not run ahead of the
    // reader.
    const items = [{ id: "prev" }, { id: "next" }];
    const tops = new Map([
      ["prev", 0],
      ["next", 1000],
    ]);

    expect(
      activeFilePathAtScrollTop(
        items,
        { scrollTop: 900, viewportHeight: 650, contentHeight: 10_000 },
        (id) => tops.get(id),
      ),
    ).toBe("prev");
  });

  it("only selects an unreachable file once it is actually visible, not merely past maxScrollTop", () => {
    // contentHeight 2000, viewportHeight 650 -> maxScrollTop 1350.
    // "unreachable" top 1900 is past maxScrollTop either way; scrollTop 1200
    // means the visible window is [1200, 1850). A top of exactly 1850 is
    // not yet visible; one pixel inside (1849) is.
    const itemsAtBoundary = [{ id: "prev" }, { id: "unreachable" }];
    const topsAtBoundary = new Map([
      ["prev", 0],
      ["unreachable", 1850],
    ]);

    expect(
      activeFilePathAtScrollTop(
        itemsAtBoundary,
        { scrollTop: 1200, viewportHeight: 650, contentHeight: 2000 },
        (id) => topsAtBoundary.get(id),
      ),
    ).toBe("prev");

    const itemsJustInside = [{ id: "prev" }, { id: "unreachable" }];
    const topsJustInside = new Map([
      ["prev", 0],
      ["unreachable", 1849],
    ]);

    expect(
      activeFilePathAtScrollTop(
        itemsJustInside,
        { scrollTop: 1200, viewportHeight: 650, contentHeight: 2000 },
        (id) => topsJustInside.get(id),
      ),
    ).toBe("unreachable");
  });
});
