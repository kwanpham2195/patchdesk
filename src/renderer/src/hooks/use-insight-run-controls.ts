import { useCallback, useState } from "react";
import * as v from "valibot";

import { definedProps } from "../../../domain/defined-props";
import type { InsightProvider } from "../../../domain/insight-provider";
import { requestJson, untrustedWriteResponseError } from "../api-client";
import { appLog } from "../lib/logger";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";
import { saveInsightRunPreference } from "../insight-run-preferences";
import { approveAgentRunRequests } from "../agent-run-requests";
import {
  useInsightRun,
  type InsightPatchOptions,
  type InsightRunController,
  type InsightRunType,
} from "./use-insight-run";
import {
  useInsightConfiguration,
  type InsightRunConfiguration,
} from "./use-insight-configuration";
import type { FindingRestoreOutcome } from "../components/analysis-reader";
import type { InsightRunDialogType } from "../components/insight-run-dialog";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";

const dismissedFindingResponseSchema = v.strictObject({
  findingId: v.pipe(v.string(), v.minLength(1)),
  status: v.literal("dismissed"),
});
const restoredFindingResponseSchema = v.strictObject({
  findingId: v.pipe(v.string(), v.minLength(1)),
  status: v.literal("open"),
});

/** Every run-side value the Insights slot renders from: the run configuration, the two per-type run controllers, and the run-dialog, finding-dismissal, and finding-restore commands. */
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
    /** The agent run request the dialog's run approves (ADR 0052). */
    requestId?: string,
  ) => void;
  readonly closeRunDialog: () => void;
  readonly confirmRun: () => void;
  readonly dismissFinding: (
    finding: AnalysisFinding,
    reason: string,
  ) => Promise<void>;
  readonly restoreFinding: (
    finding: AnalysisFinding,
  ) => Promise<FindingRestoreOutcome>;
};

/**
 * Owns the Insights slot's run side: the two `useInsightRun` controllers, the
 * run configuration, and the run-dialog, finding-dismissal, and finding-restore
 * commands.
 * Extracted out of `InsightsSlot` purely to keep that component's own body
 * short -- it isn't reused anywhere else.
 */
export function useInsightRunControls({
  workbench,
  profileId,
  reviewId,
  initialInsight,
  selectedInsight,
  onWorkbenchReplace,
  onWorkbenchPatch,
}: {
  readonly workbench: WorkbenchResponse;
  readonly profileId: string;
  readonly reviewId: string;
  readonly initialInsight: InsightRunDialogType;
  readonly selectedInsight: InsightRunDialogType;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): InsightRunControlsHook {
  const onInsightPatch = useCallback(
    (
      type: InsightRunType,
      projection: NonNullable<WorkbenchResponse["insights"][InsightRunType]>,
      options?: InsightPatchOptions,
    ): void => {
      onWorkbenchPatch({
        insights: { [type]: projection },
        ...definedProps({
          analysisReviewActions: options?.analysisReviewActions,
        }),
      });
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
    // A spec-file refusal is judged on the Change intent in the reviewed session (#500).
    refusalInputs: JSON.stringify([
      workbench.session.id,
      workbench.changeIntent?.setting ?? null,
    ]),
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
    cancelCodexActivation,
  } = useInsightConfiguration({
    profileId,
    initialInsight,
    selectedInsight,
  });
  const { catalog, provider, model, reasoning, language, catalogError } =
    configuration;
  /**
   * A disposition change also moves the Finding's review status and merge
   * readiness, which only the server projects. The reload is advisory: the
   * write is already confirmed, so a failed reload is logged and answers false.
   */
  const reloadFindingDispositions = async (
    findingId: string,
  ): Promise<boolean> => {
    try {
      const loaded = parseWorkbenchResponse(
        await requestJson("/v1/reviews/load", {
          method: "POST",
          body: { profileId, reviewId },
        }),
      );
      if (loaded === undefined)
        throw new Error("Invalid Review projection response");
      onWorkbenchPatch({
        insights: { analysis: loaded.insights.analysis },
        mergeReadiness: loaded.mergeReadiness,
        ...definedProps({
          analysisReviewActions: loaded.analysisReviewActions,
        }),
      });
      return true;
    } catch (cause) {
      appLog.warn(
        "finding-action",
        "Review reload after a Finding action failed",
        {
          findingId,
          cause: cause instanceof Error ? cause.message : "unknown",
        },
      );
      return false;
    }
  };
  /** Applies a confirmed disposition to the retained Analysis on screen. */
  const patchFindingDisposition = (
    findingId: string,
    disposition:
      | { readonly disposition: "dismissed"; readonly dismissalReason: string }
      | { readonly disposition: "open" },
  ): void => {
    const analysis = workbench.insights.analysis;
    const retained = analysis.retained;
    if (retained === undefined) return;
    onInsightPatch("analysis", {
      ...analysis,
      retained: {
        ...retained,
        value: {
          ...retained.value,
          findings: retained.value.findings.map((candidate) => {
            if (candidate.id !== findingId) return candidate;
            const { dismissalReason: _dropped, ...rest } = candidate;
            void _dropped;
            return { ...rest, ...disposition };
          }),
        },
      },
    });
  };
  const dismissFinding = async (
    finding: AnalysisFinding,
    reason: string,
  ): Promise<void> => {
    const runId = workbench.insights.analysis.retained?.runId;
    // The reader offers Dismiss only for a retained Analysis, so a missing run is a defect.
    if (runId === undefined) {
      appLog.error("finding-action", "Analysis run is unavailable", {
        findingId: finding.id,
      });
      throw new Error("Analysis run is unavailable");
    }
    const value = await requestJson(
      `/v1/reviews/insights/analysis/findings/${encodeURIComponent(finding.id)}/dismiss`,
      { method: "POST", body: { profileId, reviewId, runId, reason } },
    );
    const parsed = v.safeParse(dismissedFindingResponseSchema, value);
    if (!parsed.success || parsed.output.findingId !== finding.id)
      throw untrustedWriteResponseError("invalid-dismissed-finding-response");
    patchFindingDisposition(finding.id, {
      disposition: "dismissed",
      dismissalReason: reason,
    });
    await reloadFindingDispositions(finding.id);
  };
  const restoreFinding = async (
    finding: AnalysisFinding,
  ): Promise<FindingRestoreOutcome> => {
    const runId = workbench.insights.analysis.retained?.runId;
    // The reader offers Restore only for a retained Analysis, so a missing run is a defect.
    if (runId === undefined) {
      appLog.error("finding-action", "Analysis run is unavailable", {
        findingId: finding.id,
      });
      throw new Error("Analysis run is unavailable");
    }
    const value = await requestJson(
      `/v1/reviews/insights/analysis/findings/${encodeURIComponent(finding.id)}/restore`,
      { method: "POST", body: { profileId, reviewId, runId } },
    );
    const parsed = v.safeParse(restoredFindingResponseSchema, value);
    if (!parsed.success || parsed.output.findingId !== finding.id)
      throw untrustedWriteResponseError("invalid-restored-finding-response");
    // A dismissed Finding has no review status, so only the reload lets the open row offer Add to review.
    if (await reloadFindingDispositions(finding.id)) return "restored";
    patchFindingDisposition(finding.id, { disposition: "open" });
    return "refresh_needed";
  };
  const runs = {
    analysis: analysisRun,
    walkthrough: walkthroughRun,
    brief: briefRun,
  } satisfies Record<InsightRunType, InsightRunController>;
  const [runDialogRequestId, setRunDialogRequestId] = useState<string>();
  /**
   * `type` defaults to the rail's own selection, which is what every header
   * and empty-state button wants. The Brief's "Generate walkthrough" link is
   * the one caller that names another type, so the dialog and the run it
   * confirms are keyed by `runDialogType` rather than by the selection.
   */
  const openRunDialog = (
    action: "run" | "retry" | "regenerate",
    type?: InsightRunType,
    requestId?: string,
  ): void => {
    const dialogType = type ?? selectedInsight;
    if (catalogError) return;
    runs[dialogType].dismissStartRefusal();
    setRunDialogRequestId(requestId);
    const preference = preferencesRef.current[dialogType];
    const nextModels =
      catalog?.models.filter(
        (candidate) => candidate.provider === (preference?.provider ?? "pi"),
      ) ?? [];
    setConfiguration({
      provider: preference?.provider ?? "pi",
      reasoning: preference?.reasoning ?? "medium",
      language: preference?.language ?? "en",
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
  const closeRunDialog = (): void => {
    cancelCodexActivation();
    setConfiguration({ runDialogType: null });
  };
  const confirmRun = (): void => {
    const dialogType = configuration.runDialogType;
    if (model === null || dialogType === null) return;
    runs[dialogType].run(provider, model, reasoning, language, {
      ...definedProps({ requestId: runDialogRequestId }),
      onAccepted: (runId) => {
        closeRunDialog();
        // The start approved this type's awaiting agent request, so the bar drops it now.
        onWorkbenchPatch({
          ...definedProps({
            agentRunRequests: approveAgentRunRequests(
              workbench.agentRunRequests,
              dialogType,
              runId,
            ),
          }),
        });
        const preference = { provider, model, reasoning, language };
        saveInsightRunPreference(profileId, dialogType, preference);
        preferencesRef.current = {
          ...preferencesRef.current,
          [dialogType]: preference,
        };
      },
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
    restoreFinding,
  };
}
