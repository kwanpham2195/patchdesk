import { useRef, useState, type RefObject } from "react";

import type { CodeViewDiffItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentCommentAnchor,
  buildCommentOrder,
  commentNavAnnouncement,
  focusCommentThreadCard,
  shouldIgnoreReviewNavKey,
  type CommentAnchor,
  type CommentOrderItem,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import type { ReviewInlineAnnotation } from "../components/review-diff-view";
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
  virtualized,
}: {
  readonly viewer: RefObject<CodeViewHandle<
    ReviewInlineAnnotation | undefined
  > | null>;
  readonly activePathRef: CurrentPathRef;
  readonly items: ReadonlyArray<CommentNavigationItem>;
  readonly fileMode: "all" | "selected";
  readonly onActiveFileChange: ((path: string) => void) | undefined;
  readonly virtualized: boolean;
}): string | undefined {
  const latest = useLatestCommitted({ items, onActiveFileChange });
  const currentAnchor = useRef<CommentAnchor | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);

  useKeyboardJump(virtualized && fileMode === "all", (event, jump) => {
    if (event.key !== "{" && event.key !== "}") return;
    if (shouldIgnoreReviewNavKey(event)) return;
    event.preventDefault();
    const {
      items: currentItems,
      onActiveFileChange: currentOnActiveFileChange,
    } = latest.current;
    const direction: ReviewNavDirection =
      event.key === "}" ? "next" : "previous";
    const commentOrder: CommentAnchor[] = buildCommentOrder(currentItems);
    const target = adjacentCommentAnchor(
      commentOrder,
      currentAnchor.current,
      direction,
    );
    setStatus(commentNavAnnouncement(commentOrder, target, direction));
    if (target === undefined) return;
    currentAnchor.current = target;
    jump.start((isStale) =>
      materializeAndScrollTo({
        viewer,
        // The target's file must exist before its annotated line can scroll.
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
          // Pierre mounts the annotation portal after the target scrolls, so
          // focusCommentThreadCard polls a bounded number of animation frames.
          // `isStale` also covers this listener being torn down, which is what
          // stops the poll outliving the surface it started on.
          focusCommentThreadCard(target.id, isStale);
        },
      }),
    );
  });

  return status;
}
