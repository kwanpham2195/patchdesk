// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { useReviewDiffSelectionScroll } from "../../src/renderer/src/hooks/use-review-diff-scroll-state";

const items = [{ id: "src/a.ts" }, { id: "src/b.ts" }];
const selectionTarget = { type: "item", id: "src/b.ts", align: "start" };

/**
 * A viewer handle whose own item list is what `held` reports -- which is what
 * a scroll resolves against, and not necessarily the list React rendered.
 */
function fakeViewer(scrollTo: () => void, held: () => ReadonlyArray<string>) {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- CodeViewHandle has nine methods and this hook only reaches scrollTo and getInstance; a full structural stub would say nothing extra.
  const handle = {
    scrollTo,
    getInstance: () => ({
      getItem: (id: string) => (held().includes(id) ? { id } : undefined),
    }),
  } as unknown as CodeViewHandle<undefined>;
  return { current: handle };
}

// `materializeAndScrollTo` waits two animation frames before it scrolls.
function flushFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

describe("useReviewDiffSelectionScroll", () => {
  it("scrolls to the selection again after the Markdown preview closes", async () => {
    const scrollTo = vi.fn();
    const viewer = fakeViewer(scrollTo, () => ["src/a.ts", "src/b.ts"]);
    const { rerender } = renderHook(
      ({
        markdownPreviewActive,
      }: {
        readonly markdownPreviewActive: boolean;
      }) =>
        useReviewDiffSelectionScroll({
          viewer,
          items,
          selectedPath: "src/b.ts",
          selectedLines: null,
          diffStyle: "unified",
          fileMode: "all",
          markdownPreviewActive,
        }),
      { initialProps: { markdownPreviewActive: false } },
    );

    await flushFrames();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(selectionTarget);

    // A completed selection scroll stays completed while nothing changes.
    scrollTo.mockClear();
    await flushFrames();
    expect(scrollTo).not.toHaveBeenCalled();

    rerender({ markdownPreviewActive: true });
    await flushFrames();
    rerender({ markdownPreviewActive: false });
    await flushFrames();

    // The preview unmounted CodeView, so the remounted viewer starts at the
    // top and the selection has to be scrolled to again.
    expect(scrollTo).toHaveBeenLastCalledWith(selectionTarget);
  });

  it("leaves the viewer alone while it does not hold the selected file", async () => {
    const scrollTo = vi.fn();
    // The Scope filter has widened, so React already renders src/b.ts while
    // the viewer still holds the narrowed list. Scrolling to it there only
    // logs `CodeView.scrollTo: unknown item id` and moves nothing.
    let held: ReadonlyArray<string> = ["src/a.ts"];
    const viewer = fakeViewer(scrollTo, () => held);
    const { rerender } = renderHook(
      ({ rendered }: { readonly rendered: typeof items }) =>
        useReviewDiffSelectionScroll({
          viewer,
          items: rendered,
          selectedPath: "src/b.ts",
          selectedLines: null,
          diffStyle: "unified",
          fileMode: "all",
          markdownPreviewActive: false,
        }),
      { initialProps: { rendered: items } },
    );

    await flushFrames();
    expect(scrollTo).not.toHaveBeenCalled();

    // Once the viewer has taken the wider list the selection scroll lands:
    // the guard skips an attempt, it does not abandon the selection.
    held = ["src/a.ts", "src/b.ts"];
    rerender({ rendered: [...items] });
    await flushFrames();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(selectionTarget);
  });
});
