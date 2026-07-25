import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CodeViewDiffItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

const VIRTUAL_FILE_BATCH_SIZE = 5;

export type PierreCodeView = NonNullable<
  ReturnType<CodeViewHandle<undefined>["getInstance"]>
>;

export type ProgressiveReviewDiffStream = {
  readonly loadedCount: number;
  /** Current exclusive item index; selection reads it without restarting the scroll effect. */
  readonly nextItemIndex: RefObject<number>;
  readonly appendItemsThrough: (lastIndex: number) => void;
  readonly appendVisibleBatch: () => void;
  readonly handleViewerScroll: (
    scrollTop: number,
    codeView: PierreCodeView,
  ) => void;
};

/**
 * Adds virtualized files in small, hydrated batches. The native CodeView
 * owns scrolling; this hook only asks it to continue at an appended file.
 */
export function useProgressiveReviewDiffStream({
  items,
  fileMode,
  hydrateFiles,
  viewerContainer,
}: {
  readonly items: ReadonlyArray<CodeViewDiffItem>;
  readonly fileMode: "all" | "selected";
  readonly hydrateFiles: (paths: ReadonlyArray<string>) => Promise<void>;
  readonly viewerContainer: RefObject<HTMLDivElement | null>;
}): ProgressiveReviewDiffStream {
  const [loadedCount, setLoadedCount] = useState(1);
  const isAppendingBatch = useRef(false);
  const streamGeneration = useRef(0);
  const nextItemIndex = useRef(1);

  useEffect(() => {
    streamGeneration.current += 1;
    isAppendingBatch.current = false;
    nextItemIndex.current = 1;
    setLoadedCount(1);
  }, [fileMode]);

  useEffect(() => {
    void hydrateFiles(items.slice(0, loadedCount).map((item) => item.id));
  }, [hydrateFiles, items, loadedCount]);

  const appendItemsThrough = useCallback(
    (lastIndex: number): void => {
      const start = nextItemIndex.current;
      const end = Math.min(lastIndex + 1, items.length);
      if (start >= end) return;
      nextItemIndex.current = end;
      setLoadedCount(end);
    },
    [items],
  );

  const appendVisibleBatch = useCallback(
    (): void => {
      if (isAppendingBatch.current) return;
      const start = nextItemIndex.current;
      if (start >= items.length) return;
      const appendedPaths = items
        .slice(start, Math.min(start + VIRTUAL_FILE_BATCH_SIZE, items.length))
        .map((item) => item.id);
      const generation = streamGeneration.current;
      isAppendingBatch.current = true;
      void hydrateFiles(appendedPaths).finally(() => {
        if (generation !== streamGeneration.current) {
          isAppendingBatch.current = false;
          return;
        }
        appendItemsThrough(start + VIRTUAL_FILE_BATCH_SIZE - 1);
        isAppendingBatch.current = false;
      });
    },
    [appendItemsThrough, hydrateFiles, items],
  );

  const handleViewerScroll = useCallback(
    (scrollTop: number, codeView: PierreCodeView): void => {
      const root = viewerContainer.current;
      if (
        root === null ||
        fileMode !== "all" ||
        scrollTop + root.clientHeight < codeView.getScrollHeight() - 200
      ) {
        return;
      }
      appendVisibleBatch();
    },
    [appendVisibleBatch, fileMode, viewerContainer],
  );

  return {
    loadedCount,
    nextItemIndex,
    appendItemsThrough,
    appendVisibleBatch,
    handleViewerScroll,
  };
}
