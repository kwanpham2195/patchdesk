// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useAnalysisVerification } from "../../src/renderer/src/hooks/use-analysis-verification";
import type { ReviewWorkbenchPatch } from "../../src/renderer/src/flows/use-review-observation";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { withAnalysis } from "./review-workbench-fixtures";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

const verificationPath = "/v1/reviews/insights/analysis/verification";

type AnalysisProjection = WorkbenchResponse["insights"]["analysis"];

function analysisFor(
  runId: string,
  checkedStepIndexes: ReadonlyArray<number>,
): AnalysisProjection {
  const analysis = withAnalysis("actionable").insights.analysis;
  if (analysis.retained === undefined)
    throw new Error("fixture has no Analysis");
  return {
    ...analysis,
    retained: { ...analysis.retained, runId },
    verification: { checkedStepIndexes: [...checkedStepIndexes] },
  };
}

function renderVerification(
  patches: ReviewWorkbenchPatch[],
  analysis: AnalysisProjection,
) {
  return renderHook(
    (props: { readonly analysis: AnalysisProjection }) =>
      useAnalysisVerification({
        profileId: "profile",
        reviewId: "review-42",
        analysis: props.analysis,
        onWorkbenchPatch: (patch) => patches.push(patch),
      }),
    { initialProps: { analysis } },
  );
}

describe("useAnalysisVerification", () => {
  it("ticks a step at once and saves only that step for the retained run", async () => {
    desktop = installDesktopDouble({
      [verificationPath]: () => success({ checkedStepIndexes: [0, 2] }),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderVerification(
      patches,
      analysisFor("analysis-run-1", [0]),
    );

    act(() => result.current.setStepChecked(2, true));

    expect([...result.current.checkedSteps]).toEqual([0, 2]);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(desktop.request.mock.calls[0]?.[0]).toMatchObject({
      path: verificationPath,
      method: "POST",
      body: {
        profileId: "profile",
        reviewId: "review-42",
        runId: "analysis-run-1",
        stepIndex: 2,
        checked: true,
      },
    });
    expect(patches[0]?.insights?.analysis).toMatchObject({
      retained: { runId: "analysis-run-1" },
      verification: { checkedStepIndexes: [0, 2] },
    });
    expect(result.current.saveFailed).toBe(false);
  });

  it("unticks the step again and reports the failure when the save fails", async () => {
    desktop = installDesktopDouble({
      [verificationPath]: () => failure({ error: "storage_unavailable" }),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderVerification(
      patches,
      analysisFor("analysis-run-1", []),
    );

    act(() => result.current.setStepChecked(1, true));

    await waitFor(() => expect(result.current.saveFailed).toBe(true));
    expect(result.current.checkedSteps.has(1)).toBe(false);
    expect(patches).toEqual([]);
  });

  it("starts a regenerated Analysis from its own stored ticks", () => {
    const { result, rerender } = renderVerification(
      [],
      analysisFor("analysis-run-1", [0]),
    );

    rerender({ analysis: analysisFor("analysis-run-2", []) });

    expect(result.current.checkedSteps.size).toBe(0);
  });
});
