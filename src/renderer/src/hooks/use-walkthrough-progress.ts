import { useRef, useState } from "react";

import { requestJson } from "../api-client";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";
import { useLatestCommitted } from "./use-latest-committed";

type WalkthroughProgress = NonNullable<
  WorkbenchResponse["insights"]["walkthrough"]["progress"]
>;

/** The reviewed marks and open section one Walkthrough reader renders and edits. */
export type WalkthroughProgressControls = {
  readonly progress: WalkthroughProgress;
  readonly saveFailed: boolean;
  readonly markSectionReviewed: (sectionId: string) => void;
  readonly markSupportReviewed: () => void;
  readonly selectSection: (sectionId: string) => void;
};

const NO_PROGRESS: WalkthroughProgress = {
  reviewedSectionIds: [],
  supportReviewed: false,
};

/**
 * Owns the reading progress of the retained Walkthrough: each change applies at
 * once and is saved whole, and a saved change is written back to the workbench.
 */
export function useWalkthroughProgress({
  profileId,
  reviewId,
  walkthrough,
  onWorkbenchPatch,
}: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly walkthrough: WorkbenchResponse["insights"]["walkthrough"];
  /** Receives the saved progress so a remounted Insights slot starts from it. */
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): WalkthroughProgressControls {
  const runId = walkthrough.retained?.runId;
  const savedProgress = walkthrough.progress ?? NO_PROGRESS;
  const [state, setState] = useState<{
    readonly runId: string | undefined;
    readonly progress: WalkthroughProgress;
    readonly saveFailed: boolean;
  }>(() => ({ runId, progress: savedProgress, saveFailed: false }));
  // A regenerated Walkthrough starts from its own stored progress, never the previous run's.
  if (state.runId !== runId)
    setState({ runId, progress: savedProgress, saveFailed: false });
  const generation = useRef(0);
  const latest = useLatestCommitted({ walkthrough, onWorkbenchPatch });

  const save = (progress: WalkthroughProgress): void => {
    setState((current) => ({ ...current, progress }));
    if (runId === undefined) return;
    const request = ++generation.current;
    void requestJson("/v1/reviews/insights/walkthrough/progress", {
      method: "POST",
      body: { profileId, reviewId, runId, ...progress },
    })
      .then(() => {
        // An older response must not overwrite progress a later request already saved.
        if (request !== generation.current) return;
        const current = latest.current;
        if (current.walkthrough.retained?.runId === runId)
          current.onWorkbenchPatch({
            insights: { walkthrough: { ...current.walkthrough, progress } },
          });
        setState((current) =>
          current.runId === runId ? { ...current, saveFailed: false } : current,
        );
      })
      .catch(() => {
        setState((current) =>
          current.runId === runId ? { ...current, saveFailed: true } : current,
        );
      });
  };

  const { progress } = state;
  return {
    progress,
    saveFailed: state.saveFailed,
    markSectionReviewed: (sectionId) =>
      save({
        ...progress,
        reviewedSectionIds: progress.reviewedSectionIds.includes(sectionId)
          ? progress.reviewedSectionIds
          : [...progress.reviewedSectionIds, sectionId],
      }),
    markSupportReviewed: () => save({ ...progress, supportReviewed: true }),
    selectSection: (sectionId) =>
      save({ ...progress, currentSectionId: sectionId }),
  };
}
