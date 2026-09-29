import { useCallback } from "react";

import type { ChangeScopeBucket } from "../../../domain/change-scope";
import type { LocalPatchView } from "../../../domain/local-patch-view";
import type { ReviewWorkbenchFindingNavigation } from "../components/review-workbench-finding-navigation";
import type { ReviewWorkbenchPositionState } from "./use-review-workbench-position";

/**
 * Owns how an Insight reader opens the Diff. A Brief's file and Scope card
 * stand for the whole represented revision, so both leave Since your review
 * or Since last Refresh and return to the Combined view before pointing the Diff anywhere.
 */
export function useInsightDiffNavigation({
  position,
  selectPatchView,
  leaveNarrowedDiff,
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
  /** Turns Since your review and Since last Refresh off. */
  readonly leaveNarrowedDiff: () => void;
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
      leaveNarrowedDiff();
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
      leaveNarrowedDiff,
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
      leaveNarrowedDiff();
      selectPatchView("combined");
      applyScopeBucket(bucket);
    },
    [applyScopeBucket, leaveNarrowedDiff, selectPatchView],
  );
  return { openFileInDiff, openScopeBucketInDiff };
}
