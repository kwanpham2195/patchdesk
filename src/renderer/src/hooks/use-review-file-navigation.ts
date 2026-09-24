import { useEffect, useRef, type RefObject } from "react";

import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentFilePath,
  adjacentUnviewedFilePath,
  fileNavigationStatus,
  shouldIgnoreReviewNavKey,
  unviewedFileNavigationStatus,
  type ReviewDiffNavigationStatus,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import type { ReviewDiffNavigationOperation } from "./use-review-diff-navigation-feedback";
import { useKeyboardJump } from "./use-keyboard-jump";
import { useLatestCommitted } from "./use-latest-committed";

// `,`/`.` step through every file, `p`/`n` through unviewed files, and `v` toggles viewed.
const FILE_KEYS = new Set([",", ".", "p", "n", "v"]);

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
  collapsedPaths,
  onCollapsedPathsChange,
  onActiveFileChange,
  createNavigationOperation,
  resolveActiveFilePathAt,
  virtualized,
  browserSupportsPierre,
  markdownPreviewActive,
}: {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly activePathRef: CurrentPathRef;
  readonly items: ReadonlyArray<FileNavigationItem>;
  readonly fileMode: "all" | "selected";
  /** Viewed and collapsed are one state, so `v` toggles membership here. */
  readonly collapsedPaths: ReadonlySet<string>;
  readonly onCollapsedPathsChange: (paths: ReadonlySet<string>) => void;
  readonly onActiveFileChange: ((path: string) => void) | undefined;
  readonly createNavigationOperation: () => ReviewDiffNavigationOperation;
  readonly resolveActiveFilePathAt: (
    scrollTop: number,
    codeView: PierreCodeView<T>,
  ) => string | undefined;
  readonly virtualized: boolean;
  readonly browserSupportsPierre: boolean;
  /** The preview pane replaces CodeView, so these keys would move an
   * invisible cursor behind it. */
  readonly markdownPreviewActive: boolean;
}): void {
  const latest = useLatestCommitted({
    items,
    collapsedPaths,
    onCollapsedPathsChange,
    onActiveFileChange,
    createNavigationOperation,
  });
  const currentPath = useRef<string | undefined>(undefined);
  const enabled =
    virtualized &&
    fileMode === "all" &&
    browserSupportsPierre &&
    !markdownPreviewActive;
  // Paths only: marking a file viewed bumps its version but must keep the cursor on it.
  const itemOrder = items.map((item) => item.id).join("\u0001");

  useEffect(() => {
    currentPath.current = undefined;
  }, [enabled, itemOrder]);

  useKeyboardJump(enabled, (event, jump) => {
    if (!FILE_KEYS.has(event.key)) return;
    if (shouldIgnoreReviewNavKey(event)) return;
    event.preventDefault();
    const {
      items: currentItems,
      collapsedPaths: viewed,
      onCollapsedPathsChange: currentOnCollapsedPathsChange,
      onActiveFileChange: currentOnActiveFileChange,
      createNavigationOperation: currentCreateNavigationOperation,
    } = latest.current;
    const operation = currentCreateNavigationOperation();
    const resolveOnScreen = (): string | undefined => {
      const codeView = viewer.current?.getInstance();
      return codeView === undefined
        ? undefined
        : resolveActiveFilePathAt(codeView.getScrollTop(), codeView);
    };
    if (event.key === "v") {
      // The active file Browse highlights wins; the last toggled file covers the reset a collapse causes.
      const path =
        activePathRef.current ?? currentPath.current ?? resolveOnScreen();
      if (path === undefined) {
        operation.report({
          kind: "viewed",
          state: "unavailable",
          message: "No file on screen to mark viewed.",
        });
        return;
      }
      const next = new Set(viewed);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      currentPath.current = path;
      currentOnCollapsedPathsChange(next);
      return;
    }
    const direction: ReviewNavDirection =
      event.key === "." || event.key === "n" ? "next" : "previous";
    currentPath.current ??= resolveOnScreen();
    const order = currentItems.map((item) => item.id);
    const stepsUnviewed = event.key === "n" || event.key === "p";
    const unviewed = stepsUnviewed
      ? adjacentUnviewedFilePath(order, viewed, currentPath.current, direction)
      : undefined;
    const target = stepsUnviewed
      ? unviewed?.path
      : adjacentFilePath(order, currentPath.current, direction);
    const status = (landed: string | undefined): ReviewDiffNavigationStatus =>
      stepsUnviewed
        ? unviewedFileNavigationStatus(order, viewed, unviewed, direction)
        : fileNavigationStatus(order, landed, direction);
    if (target === undefined) {
      jump.start(() => () => undefined);
      operation.report(status(undefined));
      return;
    }
    currentPath.current = target;
    jump.start((isStale) => {
      const stale = () => isStale() || operation.isStale();
      return materializeAndScrollTo({
        viewer,
        itemId: target,
        isStale: stale,
        target: { type: "item", id: target, align: "start" },
        onScrolled: () => {
          if (stale()) return;
          activePathRef.current = target;
          currentOnActiveFileChange?.(target);
          operation.report(status(target));
        },
      });
    });
  });
}
