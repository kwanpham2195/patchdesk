import { useCallback, useMemo, useState } from "react";

import {
  changeScopeFilesFromPatch,
  changeScopePathsForBucket,
  type ChangeScope,
  type ChangeScopeBucket,
} from "../../../domain/change-scope";
import type { ReviewNavigatorSection } from "../components/review-navigator";
import type { ScopeFilterControl } from "../components/review-diff-toolbar";
import type { WorkbenchPosition } from "../lib/screen-restore";

/** Which Scope bucket the Diff is filtered by, and the files that bucket leaves visible. */
export type ReviewScopeFilterState = {
  readonly activeScopeBucket: ChangeScopeBucket | undefined;
  /** The paths Browse and the diff pane may show; absent when no filter is active. */
  readonly scopeFilteredPaths: ReadonlySet<string> | undefined;
  /** Applies a bucket, or clears the filter when that bucket is already active. */
  readonly selectScopeBucket: (bucket: ChangeScopeBucket) => void;
  /** Drives the diff toolbar's Scope picker; absent where no bucket can apply. */
  readonly scopeFilter: ScopeFilterControl | undefined;
  readonly clearScopeBucket: () => void;
};

/**
 * Owns the Diff's Scope filter. Session-local, like the thread selection: a
 * filter is a way of reading this diff now, not a place the reader asked to
 * return to, so it never reaches the restored workbench position.
 */
export function useReviewScopeFilter({
  fullPatch,
  scope,
  selectedPath,
  commitSliceActive,
  commitWorkbenchPosition,
  selectSection,
  setActivePath,
}: {
  readonly fullPatch: string | undefined;
  /** The buckets to offer; absent when the represented patch was unreadable. */
  readonly scope: ChangeScope | undefined;
  readonly selectedPath: string | undefined;
  /** A commit slice and a bucket are exclusive readings, so the picker hides behind one. */
  readonly commitSliceActive: boolean;
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
              changeScopeFilesFromPatch(fullPatch),
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
  const applyScopeBucket = useCallback(
    (bucket: ChangeScopeBucket): void => {
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
      commitWorkbenchPosition,
      scopeBucketPaths,
      selectSection,
      selectedPath,
      setActivePath,
    ],
  );
  const selectScopeBucket = useCallback(
    (bucket: ChangeScopeBucket): void => {
      if (activeScopeBucket === bucket) {
        setActiveScopeBucket(undefined);
        return;
      }
      applyScopeBucket(bucket);
    },
    [activeScopeBucket, applyScopeBucket],
  );
  const scopeFilter = useMemo<ScopeFilterControl | undefined>(
    () =>
      scope === undefined || scope.buckets.length === 0 || commitSliceActive
        ? undefined
        : {
            buckets: scope.buckets,
            activeBucket: activeScopeBucket,
            // The picker already shows which bucket is active, so choosing it
            // again is a no-op rather than the card's toggle.
            onSelect: applyScopeBucket,
            onClear: clearScopeBucket,
          },
    [
      activeScopeBucket,
      applyScopeBucket,
      clearScopeBucket,
      commitSliceActive,
      scope,
    ],
  );
  return {
    activeScopeBucket,
    scopeFilteredPaths,
    selectScopeBucket,
    scopeFilter,
    clearScopeBucket,
  };
}
