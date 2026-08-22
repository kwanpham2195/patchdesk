import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  CodeViewDiffItem,
  CodeViewLineSelection,
  FileDiffMetadata,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import {
  activeFilePathAtScrollTop,
  type ActiveFileViewport,
} from "../review-diff-active-file";
import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import { useReviewDiffQaScrollDiagnostics } from "./use-review-diff-qa-scroll-diagnostics";
import { useScrollSettledValue } from "./use-scroll-settled-value";

type PierreCodeView<T> = NonNullable<
  ReturnType<CodeViewHandle<T>["getInstance"]>
>;

type ReviewDiffScrollState<T> = {
  readonly settledHydratedFiles: ReadonlyMap<string, FileDiffMetadata>;
  readonly activePathRef: { current: string | undefined };
  readonly viewerElement: HTMLDivElement | null;
  readonly setViewerContainer: (node: HTMLDivElement | null) => void;
  readonly resolveActiveFilePathAt: (
    scrollTop: number,
    codeView: PierreCodeView<T>,
  ) => string | undefined;
  readonly handleCodeViewScroll: (
    scrollTop: number,
    codeView: PierreCodeView<T>,
  ) => void;
};

/**
 * Owns the scroll-sensitive state around the one Pierre viewer. The viewer
 * ref itself stays in ReviewDiffSurface; this hook owns the container ref,
 * measured geometry, active-file updates, and the settled hydration value.
 */
export function useReviewDiffScrollState<T>({
  viewer,
  hydratedFiles,
  fileMode,
  itemCount,
  onActiveFileChange,
}: {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly hydratedFiles: ReadonlyMap<string, FileDiffMetadata>;
  readonly fileMode: "all" | "selected";
  readonly itemCount: number;
  readonly onActiveFileChange: ((path: string) => void) | undefined;
}): ReviewDiffScrollState<T> {
  const activePathRef = useRef<string | undefined>(undefined);
  const viewerContainer = useRef<HTMLDivElement>(null);
  const [viewerElement, setViewerElement] = useState<HTMLDivElement | null>(
    null,
  );
  const { settledValue: settledHydratedFiles, notifyScroll } =
    useScrollSettledValue(hydratedFiles);

  const setViewerContainer = useCallback(
    (node: HTMLDivElement | null): void => {
      viewerContainer.current = node;
      setViewerElement(node);
      // CodeView's props don't include tabIndex/role/aria-label (it
      // destructures a closed prop list), and its own setup() only defaults
      // tabindex to -1. Apply real keyboard focusability and an accessible
      // name so native scrolling is reachable by sequential Tab navigation.
      if (node !== null) {
        node.tabIndex = 0;
        node.setAttribute("role", "region");
        node.setAttribute("aria-label", "Diff content");
      }
    },
    [],
  );

  useReviewDiffQaScrollDiagnostics(viewerElement, viewer);

  // Reads the scroll container's own clientHeight/scrollHeight for
  // `activeFilePathAtScrollTop`'s viewport geometry. When the container is not
  // mounted, both fall back to 0; this keeps the pre-mount query inert rather
  // than inventing a viewport size.
  const readActiveFileViewport = useCallback(
    (scrollTop: number): ActiveFileViewport => {
      const viewportElement = viewerContainer.current;
      return {
        scrollTop,
        viewportHeight: viewportElement?.clientHeight ?? 0,
        contentHeight: viewportElement?.scrollHeight ?? 0,
      };
    },
    [],
  );

  // This is the one active-file geometry query. It reads CodeView's measured
  // rendered window, never the full item list or estimated document offsets.
  const resolveActiveFilePathAt = useCallback(
    (scrollTop: number, codeView: PierreCodeView<T>): string | undefined =>
      activeFilePathAtScrollTop(
        codeView.getRenderedItems(),
        readActiveFileViewport(scrollTop),
        (id) => codeView.getTopForItem(id),
      ),
    [readActiveFileViewport],
  );

  const updateActivePath = useCallback(
    (scrollTop: number, codeView: PierreCodeView<T>): void => {
      if (fileMode !== "all") return;
      const path = resolveActiveFilePathAt(scrollTop, codeView);
      if (path === undefined || path === activePathRef.current) return;
      activePathRef.current = path;
      onActiveFileChange?.(path);
    },
    [fileMode, onActiveFileChange, resolveActiveFilePathAt],
  );

  useEffect(() => {
    if (fileMode !== "all") return;
    const frame = window.requestAnimationFrame(() => {
      const codeView = viewer.current?.getInstance();
      if (codeView === undefined) return;
      updateActivePath(codeView.getScrollTop(), codeView);
    });
    return () => window.cancelAnimationFrame(frame);
    // The full item list mounts at once, so its length is the signal that the
    // rendered file set changed.
  }, [fileMode, itemCount, updateActivePath, viewer]);

  // CodeView emits scroll events faster than the browser paints. Keep the
  // settling debounce on every event, but coalesce measured active-file reads
  // to one animation frame and read the latest CodeView scroll position there.
  const pendingScrollFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pendingScrollFrame.current !== null) {
        window.cancelAnimationFrame(pendingScrollFrame.current);
        pendingScrollFrame.current = null;
      }
    },
    [],
  );
  const handleCodeViewScroll = useCallback(
    (_scrollTop: number, codeView: PierreCodeView<T>): void => {
      notifyScroll();
      if (pendingScrollFrame.current !== null) return;
      pendingScrollFrame.current = window.requestAnimationFrame(() => {
        pendingScrollFrame.current = null;
        updateActivePath(codeView.getScrollTop(), codeView);
      });
    },
    [notifyScroll, updateActivePath],
  );

  return {
    settledHydratedFiles,
    activePathRef,
    viewerElement,
    setViewerContainer,
    resolveActiveFilePathAt,
    handleCodeViewScroll,
  };
}

/** Keeps a selected file/range scroll alive across settled item updates. */
export function useReviewDiffSelectionScroll<T>({
  viewer,
  items,
  selectedPath,
  selectedLines,
  diffStyle,
  fileMode,
}: {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly items: ReadonlyArray<Pick<CodeViewDiffItem<unknown>, "id">>;
  readonly selectedPath: string | undefined;
  readonly selectedLines: CodeViewLineSelection | null;
  readonly diffStyle: string;
  readonly fileMode: "all" | "selected";
}): void {
  const selectionScrollKey = [
    diffStyle,
    fileMode,
    selectedPath ?? "",
    selectedLines?.id ?? "",
    selectedLines?.range.start ?? "",
    selectedLines?.range.end ?? "",
    selectedLines?.range.side ?? "",
  ].join(":");
  // Progressive hydration, collapse toggles, and annotations can restart the
  // effect because they change `items`. Keep the append-and-retry progress
  // separate so those unrelated updates do not re-fight the user's scroll.
  const selectionScrollProgress = useRef<{
    key: string;
    completed: boolean;
  }>({ key: "", completed: false });

  useEffect(() => {
    if (selectedPath === undefined) return;
    if (selectionScrollProgress.current.key !== selectionScrollKey) {
      selectionScrollProgress.current = {
        key: selectionScrollKey,
        completed: false,
      };
    }
    if (selectionScrollProgress.current.completed) return;
    return materializeAndScrollTo({
      viewer,
      items,
      itemId: selectedPath,
      isStale: () =>
        selectionScrollProgress.current.key !== selectionScrollKey ||
        selectionScrollProgress.current.completed,
      buildTarget: () =>
        selectedLines === null
          ? { type: "item", id: selectedPath, align: "start" }
          : {
              type: "range",
              id: selectedLines.id,
              range: selectedLines.range,
              align: "center",
            },
      onScrolled: () => {
        selectionScrollProgress.current.completed = true;
      },
    });
  }, [
    fileMode,
    items,
    selectedLines,
    selectedPath,
    selectionScrollKey,
    viewer,
  ]);
}
