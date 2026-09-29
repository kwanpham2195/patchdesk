import { useMemo } from "react";

import type { WorkbenchResponse } from "../renderer-contracts";
import type { CommitDiffResponse } from "../review-diff-contracts";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
import type { ReviewWorkbenchActions } from "../components/review-workbench-contracts";
import { createHeadSideCommentAuthoring } from "../components/review-workbench-pull-request";
import { useCommitDiff, type CommitDiffState } from "./use-commit-diff";
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
  readonly sincePatch: string | undefined;
  /** True while a commit slice or the since-review diff replaces the Review's patch. */
  readonly narrowedDiff: boolean;
  /** Why the shown commit slice takes no note or comment; undefined when it does. */
  readonly sliceAuthoringNote: string | undefined;
  /** Authoring on a narrowed diff whose new side is the represented head, mapped back onto the full patch. */
  readonly commitCommentAuthoring: LocalCommentAuthoring | undefined;
};

/** Owns the narrower patches the Diff tab can show in place of the Review's: a commit slice, or the diff since the viewer's review. */
export function useNarrowedReviewDiff({
  model,
  actions,
  selectedCommitSha,
}: {
  readonly model: WorkbenchResponse;
  readonly actions: Pick<
    ReviewWorkbenchActions,
    "loadCommitDiff" | "loadSinceReviewDiff" | "localCommentAuthoring"
  >;
  readonly selectedCommitSha: string | undefined;
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
  const sinceReview = useSinceReviewMode({
    model,
    commitSliceActive: selectedCommitSha !== undefined,
    loadSinceReviewDiff: actions.loadSinceReviewDiff,
  });
  const sincePatch =
    sinceReview.state._tag === "Ready" ? sinceReview.state.patch : undefined;
  // A commit slice and the since-review diff both show a narrower patch than the Review, so comments map back onto the full patch.
  const narrowedDiff =
    selectedCommitSha !== undefined || sincePatch !== undefined;
  const commitDiff =
    selectedCommitSha !== undefined &&
    commitDiffState._tag === "Ready" &&
    commitDiffState.projection.commit.sha === selectedCommitSha
      ? commitDiffState.projection
      : undefined;
  // Only a diff whose new side is the represented head can anchor comments on GitHub.
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
    sincePatch,
    narrowedDiff,
    sliceAuthoringNote,
    commitCommentAuthoring,
  };
}
