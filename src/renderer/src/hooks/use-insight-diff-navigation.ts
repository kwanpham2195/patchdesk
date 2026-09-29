import { useCallback } from "react";

import type { ChangeScopeBucket } from "../../../domain/change-scope";
import type { LocalPatchView } from "../../../domain/local-patch-view";
import type { ReviewWorkbenchFindingNavigation } from "../components/review-workbench-finding-navigation";
import type { ReviewWorkbenchPositionState } from "./use-review-workbench-position";

/**
 * Owns how an Insight reader opens the Diff. A Brief's file and Scope card
 * stand for the whole represented revision, so both leave Since your review
 * and return to the Combined view before pointing the Diff anywhere.
 */
export function useInsightDiffNavigation({
  position,
  selectPatchView,
  leaveSinceReview,
  applyScopeBucket,
  clearScopeBucket,
}: {
  readonly position: Pick<
    ReviewWorkbenchPositionState,
    | "selectSection"
    | "commitWorkbenchPosition"
    | "setSelectedRange"
    | "setSelectedThreadId"
    | "setActivePath"
  >;
  readonly selectPatchView: (view: LocalPatchView) => void;
  /** Turns Since your review off; absent when that mode is not offered. */
  readonly leaveSinceReview: ((active: boolean) => void) | undefined;
  readonly applyScopeBucket: (bucket: ChangeScopeBucket) => void;
  readonly clearScopeBucket: () => void;
}): Pick<
  ReviewWorkbenchFindingNavigation,
  "openFileInDiff" | "openScopeBucketInDiff"
> {
  const {
    selectSection,
    commitWorkbenchPosition,
    setSelectedRange,
    setSelectedThreadId,
    setActivePath,
  } = position;
  const openFileInDiff = useCallback(
    (path: string): void => {
      clearScopeBucket();
      leaveSinceReview?.(false);
      selectPatchView("combined");
      selectSection("files");
      setSelectedThreadId(undefined);
      setSelectedRange(undefined);
      commitWorkbenchPosition({
        activeTab: "diff",
        section: "files",
        selectedPath: path,
      });
      setActivePath(path);
    },
    [
      clearScopeBucket,
      commitWorkbenchPosition,
      leaveSinceReview,
      selectPatchView,
      selectSection,
      setActivePath,
      setSelectedRange,
      setSelectedThreadId,
    ],
  );
  // The picker's own filter, so the Diff picker shows the bucket and Clear scope undoes it (#612).
  const openScopeBucketInDiff = useCallback(
    (bucket: ChangeScopeBucket): void => {
      leaveSinceReview?.(false);
      selectPatchView("combined");
      applyScopeBucket(bucket);
    },
    [applyScopeBucket, leaveSinceReview, selectPatchView],
  );
  return { openFileInDiff, openScopeBucketInDiff };
}
