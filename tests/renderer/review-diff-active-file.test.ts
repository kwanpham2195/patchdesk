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

  it("does not let a far-off unrendered file's stale estimated top outrank the rendered window", () => {
    // Regression test for the defect the module contract above documents:
    // `getTopForItem` only returns a measured top for a file CodeView has
    // actually rendered; for anything outside that window it falls back to
    // an estimate that drifts whenever any item's layout is invalidated,
    // with nothing to do with where the reader actually scrolled. Simulate
    // that drift directly: "far-unrendered" is a file the reader hasn't
    // scrolled anywhere near, but its estimated top has drifted down to
    // 250 -- at or above scrollTop, and past "near-b"'s real top -- purely
    // from an unrelated layout recompute.
    const tops = new Map([
      ["near-a", 0],
      ["near-b", 240],
      ["far-unrendered", 250],
    ]);

    // The fix: callers pass only the rendered window (what
    // `codeView.getRenderedItems()` returns), which never includes
    // "far-unrendered" in the first place, so its drifted estimate can
    // never be compared at all.
    const renderedWindow = [{ id: "near-a" }, { id: "near-b" }];
    expect(
      activeFilePathAtScrollTop(renderedWindow, viewport(260), (id) =>
        tops.get(id),
      ),
    ).toBe("near-b");

    // The defect, reproduced directly: feeding the full item list back in
    // (the old, wrong behavior) lets "far-unrendered"'s drifted estimate
    // (250) beat "near-b"'s real top (240) and wrongly take over as the
    // active file, even though the reader never scrolled near it.
    const fullList = [...renderedWindow, { id: "far-unrendered" }];
    expect(
      activeFilePathAtScrollTop(fullList, viewport(260), (id) => tops.get(id)),
    ).toBe("far-unrendered");
  });

  it("falls back to the rendered window's first item when scrollTop sits in the paddingTop gap", () => {
    // Regression test for the sticky-header/tree mismatch: CodeView's
    // DEFAULT_CODE_VIEW_LAYOUT.paddingTop is 8
    // (@pierre/diffs/dist/constants.js), and getTopForItem adds it to every
    // item's top (@pierre/diffs/dist/components/CodeView.js), so the very
    // first rendered item's real, measured top is 8 -- never 0. At scrollTop
    // 0, "first"'s top (8) fails `top <= scrollTop` (reachable-and-at-top),
    // and fails `unreachableButVisible` too on a list taller than the
    // viewport, so the pre-fallback loop finds nothing even though the
    // reader is looking at exactly this item.
    const items = [{ id: "first" }, { id: "second" }];
    const tops = new Map([
      ["first", 8],
      ["second", 300],
    ]);

    expect(
      activeFilePathAtScrollTop(items, viewport(0), (id) => tops.get(id)),
    ).toBe("first");
  });

  it("still returns undefined when no item in the window has a measured top", () => {
    // The fallback must not invent an active file out of thin air: if every
    // item's top is undefined (nothing in the rendered window has been
    // measured yet), there is nothing on screen to report, and the caller's
    // early-return-on-undefined must keep whatever it already had.
    const items = [{ id: "first" }, { id: "second" }];

    expect(
      activeFilePathAtScrollTop(items, viewport(0), () => undefined),
    ).toBeUndefined();
  });
});
