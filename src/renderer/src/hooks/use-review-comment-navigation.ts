import { useEffect, useRef, useState, type RefObject } from "react";

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
  const jump = useRef<{ token: number; cancel?: () => void }>({ token: 0 });
  const currentAnchor = useRef<CommentAnchor | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!virtualized || fileMode !== "all") return;
    // Guards the bounded post-scroll focus poll against outliving this effect
    // when a mode changes or the surface unmounts.
    let cancelled = false;
    const onKeyDown = (event: KeyboardEvent): void => {
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
      jump.current.cancel?.();
      const token = jump.current.token + 1;
      jump.current.token = token;
      jump.current.cancel = materializeAndScrollTo({
        viewer,
        // The target's file must exist before its annotated line can scroll.
        items: currentItems,
        itemId: target.filePath,
        isStale: () => jump.current.token !== token,
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
          focusCommentThreadCard(
            target.id,
            () => cancelled || jump.current.token !== token,
          );
        },
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
      jump.current.cancel?.();
    };
  }, [activePathRef, fileMode, latest, viewer, virtualized]);

  return status;
}
