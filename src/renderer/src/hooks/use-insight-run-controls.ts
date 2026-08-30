import { useCallback } from "react";
import * as v from "valibot";

import type { InsightProvider } from "../../../domain/insight-provider";
import { requestJson } from "../api-client";
import type { WorkbenchResponse } from "../renderer-contracts";
import { saveInsightRunPreference } from "../insight-run-preferences";
import {
  useInsightRun,
  type InsightRunController,
  type InsightRunType,
} from "./use-insight-run";
import {
  useInsightConfiguration,
  type InsightRunConfiguration,
} from "./use-insight-configuration";
import type { InsightSelection } from "../components/insight-panels";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";

const dismissedFindingResponseSchema = v.strictObject({
  findingId: v.pipe(v.string(), v.minLength(1)),
  status: v.literal("dismissed"),
});

/** Every run-side value the Insights slot renders from: the run configuration, the two per-type run controllers, and the run-dialog and finding-dismissal commands. */
type InsightRunControlsHook = {
  readonly configuration: InsightRunConfiguration;
  readonly setConfiguration: (patch: Partial<InsightRunConfiguration>) => void;
  readonly changeProvider: (provider: InsightProvider) => void;
  readonly activateCodex: () => void;
  readonly analysisRun: InsightRunController;
  readonly walkthroughRun: InsightRunController;
  readonly briefRun: InsightRunController;
  readonly openRunDialog: (
    action: "run" | "retry" | "regenerate",
    type?: InsightRunType,
  ) => void;
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
      type: InsightRunType,
      projection: NonNullable<WorkbenchResponse["insights"][InsightRunType]>,
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
  const briefRun = useInsightRun({
    profileId,
    reviewId,
    type: "brief",
    activeRun: workbench.insights.brief?.activeRun,
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
  const dismissFinding = async (
    finding: AnalysisFinding,
    reason: string,
  ): Promise<void> => {
    const runId = workbench.insights.analysis.retained?.runId;
    if (runId === undefined) throw new Error("Analysis run is unavailable");
    const value = await requestJson(
      `/v1/reviews/insights/analysis/findings/${encodeURIComponent(finding.id)}/dismiss`,
      { method: "POST", body: { profileId, reviewId, runId, reason } },
    );
    const parsed = v.safeParse(dismissedFindingResponseSchema, value);
    if (!parsed.success || parsed.output.findingId !== finding.id)
      throw new Error("Invalid dismissed Finding response");
    const analysis = workbench.insights.analysis;
    const retained = analysis.retained;
    if (retained === undefined) throw new Error("Analysis run is unavailable");
    onInsightPatch("analysis", {
      ...analysis,
      retained: {
        ...retained,
        value: {
          ...retained.value,
          findings: retained.value.findings.map((candidate) =>
            candidate.id === finding.id
              ? { ...candidate, disposition: "dismissed" as const }
              : candidate,
          ),
        },
      },
    });
  };
  const runs = {
    analysis: analysisRun,
    walkthrough: walkthroughRun,
    brief: briefRun,
  } satisfies Record<InsightRunType, InsightRunController>;
  /**
   * `type` defaults to the rail's own selection, which is what every header
   * and empty-state button wants. The Brief's "Generate walkthrough" link is
   * the one caller that names another type, so the dialog and the run it
   * confirms are keyed by `runDialogType` rather than by the selection.
   */
  const openRunDialog = (
    action: "run" | "retry" | "regenerate",
    type?: InsightRunType,
  ): void => {
    const dialogType =
      type ?? (selectedInsight === "overview" ? undefined : selectedInsight);
    if (dialogType === undefined || catalogError) return;
    const preference = preferencesRef.current[dialogType];
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
      runDialogType: dialogType,
      runDialogAction: action,
    });
  };
  const closeRunDialog = (): void => setConfiguration({ runDialogType: null });
  const confirmRun = (): void => {
    const dialogType = configuration.runDialogType;
    if (model === null || dialogType === null) return;
    runs[dialogType].run(provider, model, reasoning, () => {
      closeRunDialog();
      saveInsightRunPreference(profileId, dialogType, {
        provider,
        model,
        reasoning,
      });
      preferencesRef.current = {
        ...preferencesRef.current,
        [dialogType]: { provider, model, reasoning },
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
    briefRun,
    openRunDialog,
    closeRunDialog,
    confirmRun,
    dismissFinding,
  };
}
