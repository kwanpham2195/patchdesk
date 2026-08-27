import { useRef, useState, type RefObject } from "react";

import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentFilePath,
  shouldIgnoreReviewNavKey,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import { useKeyboardJump } from "./use-keyboard-jump";
import { useLatestCommitted } from "./use-latest-committed";

type PierreCodeView<T> = NonNullable<
  ReturnType<CodeViewHandle<T>["getInstance"]>
>;

type FileNavigationItem = {
  readonly id: string;
};

type CurrentPathRef = {
  current: string | undefined;
};

export function useReviewFileNavigation<T>({
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
  readonly items: ReadonlyArray<FileNavigationItem>;
  readonly fileMode: "all" | "selected";
  readonly onActiveFileChange: ((path: string) => void) | undefined;
  readonly resolveActiveFilePathAt: (
    scrollTop: number,
    codeView: PierreCodeView<T>,
  ) => string | undefined;
  readonly virtualized: boolean;
}): string | undefined {
  // `items` and `onActiveFileChange` are read from this latest-committed
  // snapshot instead of the effect's own dependency array so an unrelated
  // re-render (a file hydrating, an annotation changing) never tears down the
  // listener or cancels a jump already in flight.
  const latest = useLatestCommitted({ items, onActiveFileChange });
  // Keep the keyboard target separate from activePathRef. An item jump lands
  // below its sticky header, so scroll-derived active-file updates can briefly
  // report the previous file after the jump completes.
  const currentPath = useRef<string | undefined>(undefined);
  const [boundary, setBoundary] = useState<string | undefined>(undefined);

  // Only the primary, continuously-scrolling diff surface supports file
  // jumps. Walkthrough and finding-evidence cards render with
  // virtualized={false}; selected-file mode has no adjacent item to target.
  useKeyboardJump(virtualized && fileMode === "all", (event, jump) => {
    if (event.key !== "." && event.key !== ",") return;
    if (shouldIgnoreReviewNavKey(event)) return;
    event.preventDefault();
    const {
      items: currentItems,
      onActiveFileChange: currentOnActiveFileChange,
    } = latest.current;
    const direction: ReviewNavDirection =
      event.key === "." ? "next" : "previous";
    // The first press starts from the file nearest the current scroll
    // position instead of always starting from the first file.
    if (currentPath.current === undefined) {
      const codeView = viewer.current?.getInstance();
      currentPath.current =
        codeView === undefined
          ? undefined
          : resolveActiveFilePathAt(codeView.getScrollTop(), codeView);
    }
    const target = adjacentFilePath(
      currentItems.map((item) => item.id),
      currentPath.current,
      direction,
    );
    if (target === undefined) {
      setBoundary(
        direction === "next"
          ? "Already at the last file."
          : "Already at the first file.",
      );
      return;
    }
    setBoundary(undefined);
    // Set eagerly so a rapid second press advances from this target even
    // before the first scroll resolves.
    currentPath.current = target;
    jump.start((isStale) =>
      materializeAndScrollTo({
        viewer,
        items: currentItems,
        itemId: target,
        isStale,
        buildTarget: () => ({ type: "item", id: target, align: "start" }),
        onScrolled: () => {
          activePathRef.current = target;
          currentOnActiveFileChange?.(target);
        },
      }),
    );
  });

  return boundary;
}
