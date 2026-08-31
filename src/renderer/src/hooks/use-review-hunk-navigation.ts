import { useEffect, useRef, type RefObject } from "react";

import type { Hunk, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentHunkAnchor,
  hunkNavigationStatus,
  shouldIgnoreReviewNavKey,
  type HunkAnchor,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import type { ReviewDiffNavigationOperation } from "./use-review-diff-navigation-feedback";
import { useKeyboardJump } from "./use-keyboard-jump";
import { useLatestCommitted } from "./use-latest-committed";

type PierreCodeView<T> = NonNullable<
  ReturnType<CodeViewHandle<T>["getInstance"]>
>;

type HunkNavigationItem = {
  readonly id: string;
  readonly version?: number;
  readonly fileDiff: Pick<FileDiffMetadata, "hunks">;
};

type CurrentPathRef = {
  current: string | undefined;
};

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
  createNavigationOperation,
  resolveActiveFilePathAt,
  virtualized,
  browserSupportsPierre,
}: {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly activePathRef: CurrentPathRef;
  readonly items: ReadonlyArray<HunkNavigationItem>;
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
  const currentAnchor = useRef<HunkAnchor | undefined>(undefined);
  const enabled = virtualized && fileMode === "all" && browserSupportsPierre;
  const hunkOrderIdentity = items
    .flatMap((item) =>
      item.fileDiff.hunks.map((hunk) => {
        const anchor = hunkAnchor(item.id, hunk);
        return `${item.version}\u0000${anchor.filePath}\u0000${anchor.lineNumber}\u0000${anchor.side}`;
      }),
    )
    .join("\u0001");

  useEffect(() => {
    currentAnchor.current = undefined;
  }, [enabled, hunkOrderIdentity]);

  useKeyboardJump(enabled, (event, jump) => {
    if (event.key !== "[" && event.key !== "]") return;
    if (shouldIgnoreReviewNavKey(event)) return;
    event.preventDefault();
    const {
      items: currentItems,
      onActiveFileChange: currentOnActiveFileChange,
      createNavigationOperation: currentCreateNavigationOperation,
    } = latest.current;
    const direction: ReviewNavDirection =
      event.key === "]" ? "next" : "previous";
    const operation = currentCreateNavigationOperation();
    const hunkOrder: HunkAnchor[] = currentItems.flatMap((item) =>
      item.fileDiff.hunks.map((hunk) => hunkAnchor(item.id, hunk)),
    );
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
      jump.start(() => () => undefined);
      operation.report(hunkNavigationStatus(hunkOrder, target, direction));
      return;
    }
    currentAnchor.current = target;
    jump.start((isStale) => {
      const stale = () => isStale() || operation.isStale();
      return materializeAndScrollTo({
        viewer,
        items: currentItems,
        itemId: target.filePath,
        isStale: stale,
        buildTarget: () => ({
          type: "line",
          id: target.filePath,
          lineNumber: target.lineNumber,
          side: target.side,
          align: "start",
        }),
        onScrolled: () => {
          if (stale()) return;
          activePathRef.current = target.filePath;
          currentOnActiveFileChange?.(target.filePath);
          operation.report(hunkNavigationStatus(hunkOrder, target, direction));
        },
      });
    });
  });
}
