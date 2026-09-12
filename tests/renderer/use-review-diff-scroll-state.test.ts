// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CodeViewLineSelection, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import {
  useReviewDiffScrollState,
  useReviewDiffSelectionScroll,
} from "../../src/renderer/src/hooks/use-review-diff-scroll-state";

const items = [{ id: "src/a.ts" }, { id: "src/b.ts" }];
const selectionTarget = { type: "item", id: "src/b.ts", align: "start" };

/** The measured tops CodeView reports for its rendered window. */
type ViewerGeometry = {
  readonly getScrollTop: () => number;
  readonly tops: ReadonlyMap<string, number>;
};

/**
 * A viewer handle whose own item list is what `held` reports -- which is what
 * a scroll resolves against, and not necessarily the list React rendered.
 * `geometry` supplies the measured window the active-file query reads.
 */
function fakeViewer(
  scrollTo: (target: { readonly id: string }) => void,
  held: () => ReadonlyArray<string>,
  geometry?: ViewerGeometry,
) {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- CodeViewHandle has nine methods and these hooks reach five of them; a full structural stub would say nothing extra.
  const handle = {
    scrollTo,
    getInstance: () => ({
      getItem: (id: string) => (held().includes(id) ? { id } : undefined),
      getScrollTop: () => geometry?.getScrollTop() ?? 0,
      getRenderedItems: () =>
        [...(geometry?.tops.keys() ?? [])].map((id) => ({ id })),
      getTopForItem: (id: string) => geometry?.tops.get(id),
    }),
  } as unknown as CodeViewHandle<undefined>;
  return { current: handle };
}

// Covers both waits `materializeAndScrollTo` can take: the two frames a range
// target waits for CodeView's remeasure, and the two frames an item target
// retries on. It cannot tell either apart from an immediate scroll, so the
// tests that pin the wait itself assert before calling this.
function flushFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

const noHydratedFiles: ReadonlyMap<string, FileDiffMetadata> = new Map();

describe("useReviewDiffScrollState", () => {
  it("does not report the outgoing file while a selection scroll is in flight", async () => {
    // Measured tops of the two rendered files. The viewport is jsdom-sized
    // (0), so the active file is whichever measured top the scroll position
    // has reached.
    const tops = new Map([
      ["src/a.ts", 8],
      ["src/b.ts", 4000],
    ]);
    let scrollTop = 8;
    const scrollTo = vi.fn((target: { readonly id: string }) => {
      scrollTop = tops.get(target.id) ?? 0;
    });
    const viewer = fakeViewer(scrollTo, () => ["src/a.ts", "src/b.ts"], {
      getScrollTop: () => scrollTop,
      tops,
    });
    const onActiveFileChange = vi.fn();

    const { rerender } = renderHook(
      ({
        itemCount,
        rendered,
        selectedPath,
      }: {
        readonly itemCount: number;
        readonly rendered: typeof items;
        readonly selectedPath: string;
      }) => {
        const state = useReviewDiffScrollState({
          viewer,
          hydratedFiles: noHydratedFiles,
          fileMode: "all",
          itemCount,
          onActiveFileChange,
        });
        useReviewDiffSelectionScroll({
          viewer,
          items: rendered,
          selectedPath,
          selectedLines: null,
          diffStyle: "unified",
          fileMode: "all",
          markdownPreviewActive: false,
          selectionScrollPending: state.selectionScrollPending,
        });
        // Mirrors review-diff-view, which clears the remembered active path
        // whenever the rendered item list changes.
        const { activePathRef } = state;
        useEffect(() => {
          activePathRef.current = undefined;
        }, [activePathRef, rendered]);
        return state;
      },
      {
        initialProps: {
          itemCount: 2,
          rendered: items,
          selectedPath: "src/a.ts",
        },
      },
    );

    await flushFrames();
    onActiveFileChange.mockClear();

    // The click on src/b.ts: the selection moves and hydration re-renders the
    // item list, while the viewer still sits at src/a.ts's scroll position.
    rerender({ itemCount: 3, rendered: [...items], selectedPath: "src/b.ts" });
    await flushFrames();

    expect(scrollTo).toHaveBeenLastCalledWith(selectionTarget);
    expect(onActiveFileChange).not.toHaveBeenCalledWith("src/a.ts");
  });
});

describe("useReviewDiffSelectionScroll", () => {
  it("scrolls to a selected file without waiting for an animation frame", () => {
    const scrollTo = vi.fn();
    const selectionScrollPending = { current: false };
    const viewer = fakeViewer(scrollTo, () => ["src/a.ts", "src/b.ts"]);

    renderHook(() =>
      useReviewDiffSelectionScroll({
        viewer,
        items,
        selectedPath: "src/b.ts",
        selectedLines: null,
        diffStyle: "unified",
        fileMode: "all",
        markdownPreviewActive: false,
        selectionScrollPending,
      }),
    );

    // An item target reads the item record straight off, so waiting frames
    // before the attempt only stalls the pane. No flush here on purpose.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(selectionTarget);
  });

  it("retries on the next frame when the viewer does not hold the file yet", async () => {
    const scrollTo = vi.fn();
    const selectionScrollPending = { current: false };
    // A first mount: the viewer takes the item list after the immediate
    // attempt has already asked for it.
    let attempts = 0;
    const viewer = fakeViewer(scrollTo, () => {
      attempts += 1;
      return attempts === 1 ? [] : ["src/a.ts", "src/b.ts"];
    });

    renderHook(() =>
      useReviewDiffSelectionScroll({
        viewer,
        items,
        selectedPath: "src/b.ts",
        selectedLines: null,
        diffStyle: "unified",
        fileMode: "all",
        markdownPreviewActive: false,
        selectionScrollPending,
      }),
    );

    expect(scrollTo).not.toHaveBeenCalled();
    await flushFrames();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(selectionTarget);
  });

  it("waits for CodeView to remeasure before scrolling to a selected range", async () => {
    const scrollTo = vi.fn();
    const selectionScrollPending = { current: false };
    const viewer = fakeViewer(scrollTo, () => ["src/a.ts", "src/b.ts"]);
    const selectedLines: CodeViewLineSelection = {
      id: "src/b.ts",
      range: { start: 12, end: 18, side: "additions" },
    };

    renderHook(() =>
      useReviewDiffSelectionScroll({
        viewer,
        items,
        selectedPath: "src/b.ts",
        selectedLines,
        diffStyle: "unified",
        fileMode: "all",
        markdownPreviewActive: false,
        selectionScrollPending,
      }),
    );

    // A range resolves through the expanded-hunks map, which is only right
    // after CodeView remeasures the expanded unchanged hunk.
    expect(scrollTo).not.toHaveBeenCalled();
    await flushFrames();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({
      type: "range",
      id: "src/b.ts",
      range: selectedLines.range,
      align: "center",
    });
  });

  it("scrolls to the selection again after the Markdown preview closes", async () => {
    const scrollTo = vi.fn();
    const selectionScrollPending = { current: false };
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
          selectionScrollPending,
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
    const selectionScrollPending = { current: false };
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
          selectionScrollPending,
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
