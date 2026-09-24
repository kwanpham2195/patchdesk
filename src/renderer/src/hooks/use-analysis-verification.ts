import { useRef, useState } from "react";
import * as v from "valibot";

import { requestJson } from "../api-client";
import { analysisVerificationSchema } from "../insight-contracts";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";
import { useLatestCommitted } from "./use-latest-committed";

/** The Verification checklist state one Analysis reader renders and edits. */
export type AnalysisVerificationControls = {
  readonly checkedSteps: ReadonlySet<number>;
  readonly saveFailed: boolean;
  readonly setStepChecked: (index: number, checked: boolean) => void;
};

/**
 * Owns the Verification ticks of the retained Analysis: ticks apply at once,
 * each one is saved as a single-step change, and a failed save unticks it again.
 */
export function useAnalysisVerification({
  profileId,
  reviewId,
  analysis,
  onWorkbenchPatch,
}: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly analysis: WorkbenchResponse["insights"]["analysis"];
  /** Receives the stored ticks so a remounted reader starts from them. */
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): AnalysisVerificationControls {
  const runId = analysis.retained?.runId;
  const savedStepIndexes = analysis.verification?.checkedStepIndexes;
  const [state, setState] = useState<{
    readonly runId: string | undefined;
    readonly checked: ReadonlySet<number>;
    readonly saveFailed: boolean;
  }>(() => ({ runId, checked: new Set(savedStepIndexes), saveFailed: false }));
  // A regenerated Analysis starts from its own stored ticks, never the previous run's.
  if (state.runId !== runId)
    setState({ runId, checked: new Set(savedStepIndexes), saveFailed: false });
  const generation = useRef(0);
  const latest = useLatestCommitted({ analysis, onWorkbenchPatch });

  const setStepChecked = (index: number, checked: boolean): void => {
    if (runId === undefined) return;
    const request = ++generation.current;
    setState((current) => ({
      ...current,
      checked: withStep(current.checked, index, checked),
    }));
    void requestJson("/v1/reviews/insights/analysis/verification", {
      method: "POST",
      body: { profileId, reviewId, runId, stepIndex: index, checked },
    })
      .then((value) => {
        const parsed = v.safeParse(analysisVerificationSchema, value);
        if (!parsed.success) throw new Error("invalid verification response");
        const current = latest.current;
        if (current.analysis.retained?.runId === runId)
          current.onWorkbenchPatch({
            insights: {
              analysis: { ...current.analysis, verification: parsed.output },
            },
          });
        // An older response must not overwrite ticks a later request already applied.
        if (request !== generation.current) return;
        setState((current) =>
          current.runId === runId
            ? {
                ...current,
                checked: new Set(parsed.output.checkedStepIndexes),
                saveFailed: false,
              }
            : current,
        );
      })
      .catch(() => {
        setState((current) =>
          current.runId === runId
            ? {
                ...current,
                checked: withStep(current.checked, index, !checked),
                saveFailed: true,
              }
            : current,
        );
      });
  };

  return {
    checkedSteps: state.checked,
    saveFailed: state.saveFailed,
    setStepChecked,
  };
}

function withStep(
  steps: ReadonlySet<number>,
  index: number,
  checked: boolean,
): ReadonlySet<number> {
  const next = new Set(steps);
  if (checked) next.add(index);
  else next.delete(index);
  return next;
}
