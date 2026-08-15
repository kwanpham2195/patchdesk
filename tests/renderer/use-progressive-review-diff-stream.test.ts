// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeViewDiffItem } from "@pierre/diffs";

import { useProgressiveReviewDiffStream } from "../../src/renderer/src/hooks/use-progressive-review-diff-stream";

type Item = CodeViewDiffItem<undefined>;
function items(count: number, prefix = "file"): ReadonlyArray<Item> {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}.ts`,
    type: "diff" as const,
    fileDiff: undefined as never,
    annotations: [],
    collapsed: false,
    version: 0,
  }));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useProgressiveReviewDiffStream", () => {
  it("hydrates one bounded visible batch and does not start another after all files load", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const hydrateFiles = async (
      paths: ReadonlyArray<string>,
    ): Promise<void> => {
      calls.push(paths);
    };
    const viewerContainer = { current: null };
    const { result } = renderHook(() =>
      useProgressiveReviewDiffStream({
        items: items(7),
        fileMode: "all",
        hydrateFiles,
        viewerContainer,
      }),
    );

    expect(result.current.loadedCount).toBe(2);
    await act(async () => {
      result.current.appendVisibleBatch();
    });
    expect(result.current.loadedCount).toBe(7);
    expect(calls).toContainEqual([
      "file-0.ts",
      "file-1.ts",
      "file-2.ts",
      "file-3.ts",
      "file-4.ts",
      "file-5.ts",
      "file-6.ts",
    ]);
    const appended = calls.filter((paths) => paths.length === 5);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toHaveLength(5);
    await act(async () => {
      result.current.appendVisibleBatch();
    });
    expect(calls.filter((paths) => paths.length === 5)).toHaveLength(1);
  });

  it("does not append a late batch into a newer stream generation", async () => {
    let resolveOld!: () => void;
    const oldBatch = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    const hydrateFiles = async (
      paths: ReadonlyArray<string>,
    ): Promise<void> => {
      if (paths.includes("file-2.ts")) await oldBatch;
    };
    const viewerContainer = { current: null };
    const { result, rerender } = renderHook(
      ({ currentItems }) =>
        useProgressiveReviewDiffStream({
          items: currentItems,
          fileMode: "all",
          hydrateFiles,
          viewerContainer,
        }),
      { initialProps: { currentItems: items(3) } },
    );

    act(() => {
      result.current.appendVisibleBatch();
    });
    rerender({ currentItems: items(4, "new") });
    expect(result.current.loadedCount).toBe(2);
    await act(async () => {
      resolveOld();
      await oldBatch;
    });
    expect(result.current.loadedCount).toBe(2);
  });
});
