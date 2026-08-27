import { useRef, useState, type RefObject } from "react";

import type { Hunk, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentHunkAnchor,
  shouldIgnoreReviewNavKey,
  type HunkAnchor,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import { useKeyboardJump } from "./use-keyboard-jump";
import { useLatestCommitted } from "./use-latest-committed";

type PierreCodeView<T> = NonNullable<
  ReturnType<CodeViewHandle<T>["getInstance"]>
>;

type HunkNavigationItem = {
  readonly id: string;
  readonly fileDiff: Pick<FileDiffMetadata, "hunks">;
};

type CurrentPathRef = {
  current: string | undefined;
};

/** The first addition line, or the first deletion line for a pure deletion. */
function hunkAnchor(filePath: string, hunk: Hunk): HunkAnchor {
  return hunk.additionCount > 0
    ? { filePath, lineNumber: hunk.additionStart, side: "additions" }
    : { filePath, lineNumber: hunk.deletionStart, side: "deletions" };
}

export function useReviewHunkNavigation<T>({
  viewer,
  activePathRef,
  items,
  fileMode,
  onActiveFileChange,
  resolveActiveFilePathAt,
  virtualized,
}: {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly activePathRef: CurrentPathRef;
  readonly items: ReadonlyArray<HunkNavigationItem>;
  readonly fileMode: "all" | "selected";
  readonly onActiveFileChange: ((path: string) => void) | undefined;
  readonly resolveActiveFilePathAt: (
    scrollTop: number,
    codeView: PierreCodeView<T>,
  ) => string | undefined;
  readonly virtualized: boolean;
}): string | undefined {
  const latest = useLatestCommitted({ items, onActiveFileChange });
  // This target is written only by keyboard jumps. It must not be replaced by
  // the scroll-derived active path after a line target lands under a header.
  const currentAnchor = useRef<HunkAnchor | undefined>(undefined);
  const [boundary, setBoundary] = useState<string | undefined>(undefined);

  useKeyboardJump(virtualized && fileMode === "all", (event, jump) => {
    if (event.key !== "[" && event.key !== "]") return;
    if (shouldIgnoreReviewNavKey(event)) return;
    event.preventDefault();
    const {
      items: currentItems,
      onActiveFileChange: currentOnActiveFileChange,
    } = latest.current;
    const direction: ReviewNavDirection =
      event.key === "]" ? "next" : "previous";
    // Rebuild the order on every press so the listener never uses a stale
    // hunk array after hydration or a controlled item update.
    const hunkOrder: HunkAnchor[] = currentItems.flatMap((item) =>
      item.fileDiff.hunks.map((hunk) => hunkAnchor(item.id, hunk)),
    );
    // CodeView exposes file geometry, not per-line geometry. Seed from the
    // first hunk in the file nearest the current viewport, then keep the
    // explicit keyboard target for subsequent presses.
    if (currentAnchor.current === undefined) {
      const codeView = viewer.current?.getInstance();
      const activePath =
        codeView === undefined
          ? undefined
          : resolveActiveFilePathAt(codeView.getScrollTop(), codeView);
      currentAnchor.current =
        activePath === undefined
          ? undefined
          : hunkOrder.find((anchor) => anchor.filePath === activePath);
    }
    const target = adjacentHunkAnchor(
      hunkOrder,
      currentAnchor.current,
      direction,
    );
    if (target === undefined) {
      setBoundary(
        direction === "next"
          ? "Already at the last hunk."
          : "Already at the first hunk.",
      );
      return;
    }
    setBoundary(undefined);
    currentAnchor.current = target;
    jump.start((isStale) =>
      materializeAndScrollTo({
        viewer,
        // The target's file must exist before a line inside it can scroll.
        items: currentItems,
        itemId: target.filePath,
        isStale,
        buildTarget: () => ({
          type: "line",
          id: target.filePath,
          lineNumber: target.lineNumber,
          side: target.side,
          align: "start",
        }),
        onScrolled: () => {
          activePathRef.current = target.filePath;
          currentOnActiveFileChange?.(target.filePath);
        },
      }),
    );
  });

  return boundary;
}
