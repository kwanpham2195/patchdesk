import { useEffect, useRef, type RefObject } from "react";

import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentFilePath,
  fileNavigationStatus,
  shouldIgnoreReviewNavKey,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import type { ReviewDiffNavigationOperation } from "./use-review-diff-navigation-feedback";
import { useKeyboardJump } from "./use-keyboard-jump";
import { useLatestCommitted } from "./use-latest-committed";

type PierreCodeView<T> = NonNullable<
  ReturnType<CodeViewHandle<T>["getInstance"]>
>;

type FileNavigationItem = {
  readonly id: string;
  readonly version?: number;
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
  createNavigationOperation,
  resolveActiveFilePathAt,
  virtualized,
  browserSupportsPierre,
}: {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly activePathRef: CurrentPathRef;
  readonly items: ReadonlyArray<FileNavigationItem>;
  readonly fileMode: "all" | "selected";
  readonly onActiveFileChange: ((path: string) => void) | undefined;
  readonly createNavigationOperation: () => ReviewDiffNavigationOperation;
  readonly resolveActiveFilePathAt: (
    scrollTop: number,
    codeView: PierreCodeView<T>,
  ) => string | undefined;
  readonly virtualized: boolean;
  readonly browserSupportsPierre: boolean;
}): void {
  const latest = useLatestCommitted({
    items,
    onActiveFileChange,
    createNavigationOperation,
  });
  const currentPath = useRef<string | undefined>(undefined);
  const enabled = virtualized && fileMode === "all" && browserSupportsPierre;
  const itemOrder = items
    .map((item) => `${item.id}\u0000${item.version}`)
    .join("\u0001");

  useEffect(() => {
    currentPath.current = undefined;
  }, [enabled, itemOrder]);

  useKeyboardJump(enabled, (event, jump) => {
    if (event.key !== "." && event.key !== ",") return;
    if (shouldIgnoreReviewNavKey(event)) return;
    event.preventDefault();
    const {
      items: currentItems,
      onActiveFileChange: currentOnActiveFileChange,
      createNavigationOperation: currentCreateNavigationOperation,
    } = latest.current;
    const direction: ReviewNavDirection =
      event.key === "." ? "next" : "previous";
    const operation = currentCreateNavigationOperation();
    if (currentPath.current === undefined) {
      const codeView = viewer.current?.getInstance();
      currentPath.current =
        codeView === undefined
          ? undefined
          : resolveActiveFilePathAt(codeView.getScrollTop(), codeView);
    }
    const order = currentItems.map((item) => item.id);
    const target = adjacentFilePath(order, currentPath.current, direction);
    if (target === undefined) {
      jump.start(() => () => undefined);
      operation.report(fileNavigationStatus(order, target, direction));
      return;
    }
    currentPath.current = target;
    jump.start((isStale) => {
      const stale = () => isStale() || operation.isStale();
      return materializeAndScrollTo({
        viewer,
        items: currentItems,
        itemId: target,
        isStale: stale,
        buildTarget: () => ({ type: "item", id: target, align: "start" }),
        onScrolled: () => {
          if (stale()) return;
          activePathRef.current = target;
          currentOnActiveFileChange?.(target);
          operation.report(fileNavigationStatus(order, target, direction));
        },
      });
    });
  });
}
