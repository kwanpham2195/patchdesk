import { useEffect, useRef, type RefObject } from "react";

import type { CodeViewDiffItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentCommentAnchor,
  buildCommentOrder,
  commentNavigationStatus,
  focusCommentThreadCard,
  shouldIgnoreReviewNavKey,
  type CommentAnchor,
  type CommentOrderItem,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import type { ReviewInlineAnnotation } from "../components/review-diff-view";
import type { ReviewDiffNavigationOperation } from "./use-review-diff-navigation-feedback";
import { useKeyboardJump } from "./use-keyboard-jump";
import { useLatestCommitted } from "./use-latest-committed";

type CommentNavigationItem = CodeViewDiffItem<
  ReviewInlineAnnotation | undefined
> &
  CommentOrderItem;

type CurrentPathRef = {
  current: string | undefined;
};

export function useReviewCommentNavigation({
  viewer,
  activePathRef,
  items,
  fileMode,
  onActiveFileChange,
  createNavigationOperation,
  virtualized,
  browserSupportsPierre,
}: {
  readonly viewer: RefObject<CodeViewHandle<
    ReviewInlineAnnotation | undefined
  > | null>;
  readonly activePathRef: CurrentPathRef;
  readonly items: ReadonlyArray<CommentNavigationItem>;
  readonly fileMode: "all" | "selected";
  readonly onActiveFileChange: ((path: string) => void) | undefined;
  readonly createNavigationOperation: () => ReviewDiffNavigationOperation;
  readonly virtualized: boolean;
  readonly browserSupportsPierre: boolean;
}): void {
  const latest = useLatestCommitted({
    items,
    onActiveFileChange,
    createNavigationOperation,
  });
  const currentAnchor = useRef<CommentAnchor | undefined>(undefined);
  const enabled = virtualized && fileMode === "all" && browserSupportsPierre;
  const commentOrderIdentity = buildCommentOrder(items)
    .map(
      (anchor) =>
        `${anchor.id}\u0000${anchor.filePath}\u0000${anchor.lineNumber}\u0000${anchor.side}`,
    )
    .join("\u0001");
  const itemVersions = items.map((item) => item.version).join("\u0000");

  useEffect(() => {
    currentAnchor.current = undefined;
  }, [enabled, commentOrderIdentity, itemVersions]);

  useKeyboardJump(enabled, (event, jump) => {
    if (event.key !== "{" && event.key !== "}") return;
    if (shouldIgnoreReviewNavKey(event)) return;
    event.preventDefault();
    const {
      items: currentItems,
      onActiveFileChange: currentOnActiveFileChange,
      createNavigationOperation: currentCreateNavigationOperation,
    } = latest.current;
    const direction: ReviewNavDirection =
      event.key === "}" ? "next" : "previous";
    const operation = currentCreateNavigationOperation();
    const commentOrder = buildCommentOrder(currentItems);
    const target = adjacentCommentAnchor(
      commentOrder,
      currentAnchor.current,
      direction,
    );
    if (target === undefined) {
      jump.start(() => () => undefined);
      operation.report(
        commentNavigationStatus(commentOrder, target, direction),
      );
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
          operation.report(
            commentNavigationStatus(commentOrder, target, direction),
          );
          focusCommentThreadCard(target.id, stale);
        },
      });
    });
  });
}
