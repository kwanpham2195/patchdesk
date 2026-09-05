import { useCallback, useMemo, useState } from "react";

import {
  changeScopePathsForBucket,
  type ChangeScopeBucket,
} from "../../../domain/change-scope";
import { parseUnifiedPatch } from "../../../domain/patch";
import type { ReviewNavigatorSection } from "../components/review-navigator";
import type { WorkbenchPosition } from "../lib/screen-restore";

/** Which Scope bucket the Diff is filtered by, and the files that bucket leaves visible. */
export type ReviewScopeFilterState = {
  readonly activeScopeBucket: ChangeScopeBucket | undefined;
  /** The paths Browse and the diff pane may show; absent when no filter is active. */
  readonly scopeFilteredPaths: ReadonlySet<string> | undefined;
  /** Applies a bucket, or clears the filter when that bucket is already active. */
  readonly selectScopeBucket: (bucket: ChangeScopeBucket) => void;
  readonly clearScopeBucket: () => void;
};

/**
 * Owns the Diff's Scope filter. Session-local, like the thread selection: a
 * filter is a way of reading this diff now, not a place the reader asked to
 * return to, so it never reaches the restored workbench position.
 */
export function useReviewScopeFilter({
  fullPatch,
  selectedPath,
  commitWorkbenchPosition,
  selectSection,
  setActivePath,
}: {
  readonly fullPatch: string | undefined;
  readonly selectedPath: string | undefined;
  readonly commitWorkbenchPosition: (next: WorkbenchPosition) => void;
  readonly selectSection: (next: ReviewNavigatorSection) => void;
  readonly setActivePath: (path: string | undefined) => void;
}): ReviewScopeFilterState {
  const [activeScopeBucket, setActiveScopeBucket] = useState<
    ChangeScopeBucket | undefined
  >(undefined);
  const scopeBucketPaths = useCallback(
    (bucket: ChangeScopeBucket): ReadonlySet<string> =>
      fullPatch === undefined
        ? new Set()
        : new Set(
            changeScopePathsForBucket(
              parseUnifiedPatch(fullPatch).map((file) => ({
                path: file.newPath,
                additions: file.additions,
                deletions: file.deletions,
              })),
              bucket,
            ),
          ),
    [fullPatch],
  );
  const scopeFilteredPaths = useMemo(
    () =>
      activeScopeBucket === undefined
        ? undefined
        : scopeBucketPaths(activeScopeBucket),
    [activeScopeBucket, scopeBucketPaths],
  );
  const clearScopeBucket = useCallback((): void => {
    setActiveScopeBucket(undefined);
  }, []);
  const selectScopeBucket = useCallback(
    (bucket: ChangeScopeBucket): void => {
      if (activeScopeBucket === bucket) {
        setActiveScopeBucket(undefined);
        return;
      }
      setActiveScopeBucket(bucket);
      // Lands on the Diff's Browse section and drops any commit slice, so the
      // filtered tree and the filtered pane describe the same file set.
      selectSection("files");
      const paths = scopeBucketPaths(bucket);
      // A selection outside the bucket would leave the pane pointed at a file
      // the filter just hid, so fall back to the bucket's first file.
      const nextPath =
        selectedPath !== undefined && paths.has(selectedPath)
          ? selectedPath
          : [...paths][0];
      if (nextPath === undefined) return;
      commitWorkbenchPosition({
        activeTab: "diff",
        section: "files",
        selectedPath: nextPath,
      });
      setActivePath(nextPath);
    },
    [
      activeScopeBucket,
      commitWorkbenchPosition,
      scopeBucketPaths,
      selectSection,
      selectedPath,
      setActivePath,
    ],
  );
  return {
    activeScopeBucket,
    scopeFilteredPaths,
    selectScopeBucket,
    clearScopeBucket,
  };
}
