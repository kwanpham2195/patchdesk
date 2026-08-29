import { useCallback } from "react";

import type { InsightProvider } from "../../../domain/insight-provider";
import { requestJson } from "../api-client";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";
import { saveInsightRunPreference } from "../insight-run-preferences";
import { useInsightRun, type InsightRunController } from "./use-insight-run";
import {
  useInsightConfiguration,
  type InsightRunConfiguration,
} from "./use-insight-configuration";
import type { InsightSelection } from "../components/insight-panels";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";

/** Every run-side value the Insights slot renders from: the run configuration, the two per-type run controllers, and the run-dialog and finding-dismissal commands. */
type InsightRunControlsHook = {
  readonly configuration: InsightRunConfiguration;
  readonly setConfiguration: (patch: Partial<InsightRunConfiguration>) => void;
  readonly changeProvider: (provider: InsightProvider) => void;
  readonly activateCodex: () => void;
  readonly analysisRun: InsightRunController;
  readonly walkthroughRun: InsightRunController;
  readonly openRunDialog: (action: "run" | "retry" | "regenerate") => void;
  readonly closeRunDialog: () => void;
  readonly confirmRun: () => void;
  readonly dismissFinding: (
    finding: AnalysisFinding,
    reason: string,
  ) => Promise<void>;
};

/**
 * Owns the Insights slot's run side: the two `useInsightRun` controllers, the
 * run configuration, and the run-dialog and finding-dismissal commands.
 * Extracted out of `InsightsSlot` purely to keep that component's own body
 * short -- it isn't reused anywhere else.
 */
export function useInsightRunControls({
  workbench,
  profileId,
  reviewId,
  initialDetail,
  selectedInsight,
  onWorkbenchReplace,
  onWorkbenchPatch,
}: {
  readonly workbench: WorkbenchResponse;
  readonly profileId: string;
  readonly reviewId: string;
  readonly initialDetail: "analysis" | "walkthrough" | undefined;
  readonly selectedInsight: InsightSelection;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): InsightRunControlsHook {
  const onInsightPatch = useCallback(
    (
      type: "analysis" | "walkthrough",
      projection:
        | WorkbenchResponse["insights"]["analysis"]
        | WorkbenchResponse["insights"]["walkthrough"],
    ): void => {
      onWorkbenchPatch({ insights: { [type]: projection } });
    },
    [onWorkbenchPatch],
  );
  const analysisRun = useInsightRun({
    profileId,
    reviewId,
    type: "analysis",
    activeRun: workbench.insights.analysis.activeRun,
    onWorkbenchReplace,
    onInsightPatch,
  });
  const walkthroughRun = useInsightRun({
    profileId,
    reviewId,
    type: "walkthrough",
    activeRun: workbench.insights.walkthrough.activeRun,
    onWorkbenchReplace,
    onInsightPatch,
  });

  const {
    configuration,
    preferencesRef,
    setConfiguration,
    changeProvider,
    activateCodex,
  } = useInsightConfiguration({
    profileId,
    initialDetail,
    selectedInsight,
  });
  const { catalog, provider, model, reasoning, catalogError } = configuration;
  const reloadWorkbench = async (): Promise<void> => {
    const value = await requestJson("/v1/reviews/load", {
      method: "POST",
      body: { profileId, reviewId },
    });
    const next = parseWorkbenchResponse(value);
    if (next === undefined)
      throw new Error("Invalid Review projection response");
    onWorkbenchReplace(next);
  };
  const dismissFinding = async (
    finding: AnalysisFinding,
    reason: string,
  ): Promise<void> => {
    const runId = workbench.insights.analysis.retained?.runId;
    if (runId === undefined) throw new Error("Analysis run is unavailable");
    await requestJson(
      `/v1/reviews/insights/analysis/findings/${encodeURIComponent(finding.id)}/dismiss`,
      { method: "POST", body: { profileId, reviewId, runId, reason } },
    );
    await reloadWorkbench();
  };
  const runSelected = (onAccepted?: () => void): void => {
    if (model === null || selectedInsight === "overview") return;
    if (selectedInsight === "analysis") {
      analysisRun.run(provider, model, reasoning, onAccepted);
    } else {
      walkthroughRun.run(provider, model, reasoning, onAccepted);
    }
  };
  const openRunDialog = (action: "run" | "retry" | "regenerate"): void => {
    if (selectedInsight === "overview" || catalogError) return;
    const preference = preferencesRef.current[selectedInsight];
    const nextModels =
      catalog?.models.filter(
        (candidate) => candidate.provider === (preference?.provider ?? "pi"),
      ) ?? [];
    setConfiguration({
      provider: preference?.provider ?? "pi",
      reasoning: preference?.reasoning ?? "medium",
      models: nextModels,
      model:
        preference !== undefined &&
        nextModels.some((candidate) => candidate.id === preference.model)
          ? preference.model
          : (nextModels[0]?.id ?? null),
      runDialogType: selectedInsight,
      runDialogAction: action,
    });
  };
  const closeRunDialog = (): void => setConfiguration({ runDialogType: null });
  const confirmRun = (): void => {
    if (model === null || selectedInsight === "overview") return;
    closeRunDialog();
    runSelected(() => {
      saveInsightRunPreference(profileId, selectedInsight, {
        provider,
        model,
        reasoning,
      });
      preferencesRef.current = {
        ...preferencesRef.current,
        [selectedInsight]: { provider, model, reasoning },
      };
    });
  };
  return {
    configuration,
    setConfiguration,
    changeProvider,
    activateCodex,
    analysisRun,
    walkthroughRun,
    openRunDialog,
    closeRunDialog,
    confirmRun,
    dismissFinding,
  };
}
