import { useCallback, useMemo } from "react";

import type { LocalPatchView } from "../../../domain/local-patch-view";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { CommitDiffResponse } from "../review-diff-contracts";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
import type { ReviewWorkbenchActions } from "../components/review-workbench-contracts";
import { createHeadSideCommentAuthoring } from "../components/review-workbench-pull-request";
import { useCommitDiff, type CommitDiffState } from "./use-commit-diff";
import {
  useSinceLastRefreshMode,
  type SinceLastRefreshMode,
} from "./use-since-last-refresh-mode";
import {
  useSinceReviewMode,
  type SinceReviewMode,
} from "./use-since-review-mode";

export type NarrowedReviewDiff = {
  readonly commitDiffState: CommitDiffState;
  /** The selected commit's diff once it has loaded for that commit. */
  readonly commitDiff: CommitDiffResponse | undefined;
  readonly commitDiffError: boolean;
  readonly sinceReview: SinceReviewMode;
  readonly sinceLastRefresh: SinceLastRefreshMode;
  /** The Since your review or Since last Refresh patch while one is shown. */
  readonly sincePatch: string | undefined;
  /** Names the shown since patch, so the diff remounts when it changes. */
  readonly sinceKey: string | undefined;
  /** Why the chosen since patch is not shown; undefined while nothing failed. */
  readonly sinceFailure: string | undefined;
  /** Turns both since modes off. */
  readonly leaveSince: () => void;
  /** True while a commit slice or a since patch replaces the Review's patch. */
  readonly narrowedDiff: boolean;
  /** Why the shown commit slice takes no note or comment; undefined when it does. */
  readonly sliceAuthoringNote: string | undefined;
  /** Authoring on a narrowed diff whose new side is the represented head, mapped back onto the full patch. */
  readonly commitCommentAuthoring: LocalCommentAuthoring | undefined;
};

/** Owns the narrower patches the Diff tab can show in place of the Review's: a commit slice, the diff since the viewer's review, or the diff since the last Refresh. */
export function useNarrowedReviewDiff({
  model,
  actions,
  selectedCommitSha,
  selectPatchView,
}: {
  readonly model: WorkbenchResponse;
  readonly actions: Pick<
    ReviewWorkbenchActions,
    | "loadCommitDiff"
    | "loadSinceReviewDiff"
    | "loadSinceLastRefreshDiff"
    | "localCommentAuthoring"
  >;
  readonly selectedCommitSha: string | undefined;
  /** Switches the Patch view; Since last Refresh shows Combined, whose new side its patch shares. */
  readonly selectPatchView: (view: LocalPatchView) => void;
}): NarrowedReviewDiff {
  const commitDiffOptions = {
    revisionKey: model.revision.reviewedHeadSha,
    loadCommitDiff: actions.loadCommitDiff,
  };
  const commitDiffState = useCommitDiff(
    selectedCommitSha === undefined
      ? commitDiffOptions
      : { ...commitDiffOptions, selectedSha: selectedCommitSha },
  );
  const commitSliceActive = selectedCommitSha !== undefined;
  const sinceReview = useSinceReviewMode({
    model,
    commitSliceActive,
    loadSinceReviewDiff: actions.loadSinceReviewDiff,
  });
  const sinceLastRefresh = useSinceLastRefreshMode({
    model,
    commitSliceActive,
    loadSinceLastRefreshDiff: actions.loadSinceLastRefreshDiff,
    selectPatchView,
  });
  const sincePatch =
    sinceReview.state._tag === "Ready"
      ? sinceReview.state.patch
      : sinceLastRefresh.state._tag === "Ready"
        ? sinceLastRefresh.state.patch
        : undefined;
  const sinceKey =
    sinceReview.state._tag === "Ready"
      ? `since-${sinceReview.baseSha ?? ""}`
      : sinceLastRefresh.state._tag === "Ready"
        ? `since-refresh-${model.session.id}`
        : undefined;
  const sinceFailure =
    sinceReview.state._tag === "Failed"
      ? "The diff since your review could not be loaded."
      : sinceLastRefresh.state._tag === "Failed"
        ? "The diff since the last Refresh could not be loaded."
        : undefined;
  const leaveSinceReview = sinceReview.control?.onChange;
  const leaveSinceLastRefresh = sinceLastRefresh.control?.onChange;
  const leaveSince = useCallback(() => {
    leaveSinceReview?.(false);
    leaveSinceLastRefresh?.(false);
  }, [leaveSinceLastRefresh, leaveSinceReview]);
  // A commit slice and a since patch both show a narrower patch than the Review, so comments map back onto the full patch.
  const narrowedDiff = commitSliceActive || sincePatch !== undefined;
  const commitDiff =
    selectedCommitSha !== undefined &&
    commitDiffState._tag === "Ready" &&
    commitDiffState.projection.commit.sha === selectedCommitSha
      ? commitDiffState.projection
      : undefined;
  // Only a diff whose new side is the represented head can anchor comments on GitHub or notes on Combined.
  const headSideDiff =
    selectedCommitSha === undefined
      ? sincePatch !== undefined
      : selectedCommitSha === model.revision.reviewedHeadSha;
  const sliceAuthoringNote =
    selectedCommitSha === undefined ||
    headSideDiff ||
    actions.localCommentAuthoring?.enabled !== true
      ? undefined
      : actions.localCommentAuthoring.kind === "note"
        ? "Notes show on a Patch view, not on a single commit."
        : "Comments are available on the latest commit or All files.";
  const commitCommentAuthoring = useMemo(
    () =>
      !headSideDiff || model.fullPatch === undefined
        ? undefined
        : createHeadSideCommentAuthoring(
            actions.localCommentAuthoring,
            model.fullPatch,
          ),
    [actions.localCommentAuthoring, headSideDiff, model.fullPatch],
  );
  const commitDiffError =
    commitDiffState._tag === "Failed" &&
    commitDiffState.sha === selectedCommitSha;
  return {
    commitDiffState,
    commitDiff,
    commitDiffError,
    sinceReview,
    sinceLastRefresh,
    sincePatch,
    sinceKey,
    sinceFailure,
    leaveSince,
    narrowedDiff,
    sliceAuthoringNote,
    commitCommentAuthoring,
  };
}
