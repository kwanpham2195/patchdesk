import { useContext, useEffect, useRef, type RefObject } from "react";

import type { CodeViewDiffItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentFindingAnchor,
  buildFindingOrder,
  findingNavigationStatus,
  focusFindingCard,
  shouldIgnoreReviewNavKey,
  type FindingAnchor,
  type FindingOrderItem,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import { FindingStepSlotContext } from "../review-commands";
import type { ReviewInlineAnnotation } from "../components/review-diff-view";
import type { ReviewDiffNavigationOperation } from "./use-review-diff-navigation-feedback";
import { useKeyboardJump, type KeyboardJump } from "./use-keyboard-jump";
import { useLatestCommitted } from "./use-latest-committed";

type FindingNavigationItem = CodeViewDiffItem<
  ReviewInlineAnnotation | undefined
> &
  FindingOrderItem;

/**
 * `(` and `)` move to the previous and next Analysis Finding card in file and
 * line order, stopping at either end, under the same guard and mode rules as
 * `{` and `}`. While live, the step also fills the workbench's Finding step
 * slot for the ⌘K Next and Previous Finding commands.
 */
export function useReviewFindingNavigation({
  viewer,
  activePathRef,
  items,
  fileMode,
  onActiveFileChange,
  createNavigationOperation,
  virtualized,
  browserSupportsPierre,
  markdownPreviewActive,
}: {
  readonly viewer: RefObject<CodeViewHandle<
    ReviewInlineAnnotation | undefined
  > | null>;
  readonly activePathRef: { current: string | undefined };
  readonly items: ReadonlyArray<FindingNavigationItem>;
  readonly fileMode: "all" | "selected";
  readonly onActiveFileChange: ((path: string) => void) | undefined;
  readonly createNavigationOperation: () => ReviewDiffNavigationOperation;
  readonly virtualized: boolean;
  readonly browserSupportsPierre: boolean;
  readonly markdownPreviewActive: boolean;
}): void {
  const latest = useLatestCommitted({
    items,
    onActiveFileChange,
    createNavigationOperation,
  });
  const currentAnchor = useRef<FindingAnchor | undefined>(undefined);
  const enabled =
    virtualized &&
    fileMode === "all" &&
    browserSupportsPierre &&
    !markdownPreviewActive;
  const findingOrderIdentity = buildFindingOrder(items)
    .map((anchor) => `${anchor.id}\u0000${anchor.filePath}`)
    .join("\u0001");

  useEffect(() => {
    currentAnchor.current = undefined;
  }, [enabled, findingOrderIdentity]);

  const step = (direction: ReviewNavDirection, jump: KeyboardJump): void => {
    const { items: currentItems, createNavigationOperation: operationFor } =
      latest.current;
    const operation = operationFor();
    const order = buildFindingOrder(currentItems);
    const target = adjacentFindingAnchor(
      order,
      currentAnchor.current,
      direction,
    );
    if (target === undefined) {
      jump.start(() => () => undefined);
      operation.report(findingNavigationStatus(order, target, direction));
      return;
    }
    currentAnchor.current = target;
    jump.start((isStale) => {
      const stale = () => isStale() || operation.isStale();
      return materializeAndScrollTo({
        viewer,
        itemId: target.filePath,
        isStale: stale,
        target: {
          type: "line",
          id: target.filePath,
          lineNumber: target.lineNumber,
          side: target.side,
          align: "start",
        },
        onScrolled: () => {
          if (stale()) return;
          activePathRef.current = target.filePath;
          latest.current.onActiveFileChange?.(target.filePath);
          operation.report(findingNavigationStatus(order, target, direction));
          focusFindingCard(target.id, stale);
        },
      });
    });
  };
  const latestStep = useLatestCommitted(step);

  const activeJump = useKeyboardJump(enabled, (event, jump) => {
    if (event.key !== "(" && event.key !== ")") return;
    if (shouldIgnoreReviewNavKey(event)) return;
    event.preventDefault();
    step(event.key === ")" ? "next" : "previous", jump);
  });

  const stepSlot = useContext(FindingStepSlotContext);
  useEffect(() => {
    if (!enabled || stepSlot === undefined) return;
    const commandStep = (direction: ReviewNavDirection): void => {
      const jump = activeJump.current;
      if (jump !== undefined) latestStep.current(direction, jump);
    };
    stepSlot.current = commandStep;
    return () => {
      if (stepSlot.current === commandStep) stepSlot.current = undefined;
    };
  }, [activeJump, enabled, latestStep, stepSlot]);
}
