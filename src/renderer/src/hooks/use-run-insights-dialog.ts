import { useState } from "react";

import { definedProps } from "#src/domain/defined-props";
import { supportsInsightProvider } from "#src/domain/insight-provider-capabilities";
import type {
  AccountInsightProvider,
  InsightLanguage,
  InsightProvider,
  InsightReasoning,
} from "#src/domain/insight-provider";
import { approveAgentRunRequests } from "#src/renderer/src/agent-run-requests";
import type { InsightProviderCatalog } from "#src/renderer/src/insight-catalog-contracts";
import {
  insightRunOptionsForModel,
  insightRunOptionsForProvider,
  modelReasoningOptions,
  seedInsightRunOptions,
  type InsightRunOptions,
} from "#src/renderer/src/insight-run-options";
import type { InsightRunPreference } from "#src/renderer/src/insight-run-preferences";
import type { InsightStatus } from "#src/renderer/src/insight-status";
import type { ReviewWorkbenchPatch } from "#src/renderer/src/flows/use-review-observation";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { InsightRunController, InsightRunType } from "./use-insight-run";
import { useLatestCommitted } from "./use-latest-committed";

/** The dialog's rows in reading order, as the Insight tab strip lists them. */
export const RUN_INSIGHTS_ORDER = [
  "brief",
  "guide",
  "walkthrough",
  "analysis",
] as const satisfies ReadonlyArray<InsightRunType>;

type RunInsightsRowOptions = InsightRunOptions & { readonly checked: boolean };

/** One Insight's row: its own options, whether it is checked, and whether it is already running. */
export type RunInsightsRow = RunInsightsRowOptions & {
  readonly running: boolean;
};

export type RunInsightsDialogController = {
  readonly changeShared: (patch: Partial<InsightRunPreference>) => void;
  /** Undefined while the dialog is closed. */
  readonly rows: Readonly<Record<InsightRunType, RunInsightsRow>> | undefined;
  readonly open: () => void;
  readonly close: () => void;
  readonly setChecked: (type: InsightRunType, checked: boolean) => void;
  readonly changeProvider: (
    type: InsightRunType,
    provider: InsightProvider,
  ) => void;
  readonly changeModel: (type: InsightRunType, model: string | null) => void;
  readonly changeReasoning: (
    type: InsightRunType,
    reasoning: InsightReasoning,
  ) => void;
  readonly changeLanguage: (
    type: InsightRunType,
    language: InsightLanguage,
  ) => void;
  readonly loadAccountModels: (provider: AccountInsightProvider) => void;
  /** True while any row's start request is unanswered. */
  readonly starting: boolean;
  readonly start: () => void;
};

/**
 * Owns the Run Insights dialog: one row of run options per Insight, each
 * seeded from that type's saved preference, and a start that runs every
 * checked row through its own run controller.
 */
export function useRunInsightsDialog({
  catalog,
  preferencesRef,
  runs,
  statuses,
  agentRunRequests,
  loadAccountModels,
  cancelAccountModels,
  rememberRunPreference,
  onWorkbenchPatch,
}: {
  readonly catalog: InsightProviderCatalog | undefined;
  readonly preferencesRef: React.RefObject<
    Partial<Record<InsightRunType, InsightRunPreference>>
  >;
  readonly runs: Readonly<Record<InsightRunType, InsightRunController>>;
  readonly statuses: Readonly<Record<InsightRunType, InsightStatus>>;
  readonly agentRunRequests: WorkbenchResponse["agentRunRequests"];
  readonly loadAccountModels: (
    provider: AccountInsightProvider,
    onLoaded: (nextCatalog: InsightProviderCatalog) => void,
  ) => void;
  readonly cancelAccountModels: () => void;
  readonly rememberRunPreference: (
    type: InsightRunType,
    preference: InsightRunPreference,
  ) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): RunInsightsDialogController {
  const [options, setOptions] =
    useState<Readonly<Record<InsightRunType, RunInsightsRowOptions>>>();
  const latestRunState = useLatestCommitted({ runs, statuses });
  const isRunning = (type: InsightRunType): boolean =>
    runs[type].busy || statuses[type] === "running";
  const updateRow = (
    type: InsightRunType,
    patch: Partial<RunInsightsRowOptions>,
  ): void =>
    setOptions((current) =>
      current === undefined || isRunning(type) || runs[type].starting
        ? current
        : { ...current, [type]: { ...current[type], ...patch } },
    );
  const open = (): void => {
    const seed = (type: InsightRunType): RunInsightsRowOptions => {
      runs[type].dismissStartRefusal();
      return {
        ...seedInsightRunOptions(type, preferencesRef.current[type], catalog),
        // A current result for this revision is not paid for again unless the reviewer checks it.
        checked: !isRunning(type) && statuses[type] !== "current",
      };
    };
    setOptions({
      brief: seed("brief"),
      guide: { ...seed("guide"), checked: false },
      walkthrough: seed("walkthrough"),
      analysis: seed("analysis"),
    });
  };
  const close = (): void => {
    cancelAccountModels();
    setOptions(undefined);
  };
  const rows =
    options === undefined
      ? undefined
      : {
          brief: { ...options.brief, running: isRunning("brief") },
          guide: { ...options.guide, running: isRunning("guide") },
          walkthrough: {
            ...options.walkthrough,
            running: isRunning("walkthrough"),
          },
          analysis: { ...options.analysis, running: isRunning("analysis") },
        };
  const checkedTypes =
    rows === undefined
      ? []
      : RUN_INSIGHTS_ORDER.filter(
          (type) => rows[type].checked && !rows[type].running,
        );
  const start = (): void => {
    if (rows === undefined || checkedTypes.length === 0) return;
    const planned = checkedTypes.flatMap((type) => {
      const { provider, model, reasoning, language } = rows[type];
      const modelIds = new Set(
        rows[type].models.map((candidate) => candidate.id),
      );
      const reasons = new Set(modelReasoningOptions(rows[type].models, model));
      return model === null ||
        !modelIds.has(model) ||
        !reasons.has(reasoning) ||
        !supportsInsightProvider(type, provider)
        ? []
        : [{ type, preference: { provider, model, reasoning, language } }];
    });
    if (planned.length !== checkedTypes.length) return;
    let unanswered = planned.length;
    let refused = false;
    // Each acceptance approves its type's awaiting agent request on top of the ones approved before it.
    let requests = agentRunRequests;
    const settle = (): void => {
      unanswered -= 1;
      if (unanswered === 0 && !refused) close();
    };
    for (const { type, preference } of planned) {
      runs[type].run(
        preference.provider,
        preference.model,
        preference.reasoning,
        preference.language,
        {
          onAccepted: (runId) => {
            requests = approveAgentRunRequests(requests, type, runId);
            onWorkbenchPatch(definedProps({ agentRunRequests: requests }));
            rememberRunPreference(type, preference);
            settle();
          },
          onRefused: () => {
            refused = true;
            settle();
          },
        },
      );
    }
  };
  return {
    rows,
    open,
    close,
    changeShared: (patch) =>
      setOptions((current) => {
        if (current === undefined) return current;
        const next = { ...current };
        for (const type of RUN_INSIGHTS_ORDER) {
          const row = current[type];
          if (!row.checked || isRunning(type) || runs[type].starting) continue;
          let updated = row;
          if (
            patch.provider !== undefined &&
            supportsInsightProvider(type, patch.provider)
          )
            updated = {
              ...updated,
              ...insightRunOptionsForProvider(
                type,
                patch.provider,
                preferencesRef.current[type],
                catalog,
              ),
            };
          if (
            patch.model !== undefined &&
            updated.models.some((model) => model.id === patch.model)
          )
            updated = {
              ...updated,
              ...insightRunOptionsForModel(
                updated.models,
                patch.model,
                updated.reasoning,
              ),
            };
          if (
            patch.reasoning !== undefined &&
            modelReasoningOptions(updated.models, updated.model).includes(
              patch.reasoning,
            )
          )
            updated = { ...updated, reasoning: patch.reasoning };
          if (patch.language !== undefined)
            updated = { ...updated, language: patch.language };
          next[type] = updated;
        }
        return next;
      }),
    setChecked: (type, checked) => updateRow(type, { checked }),
    changeProvider: (type, provider) => {
      if (!supportsInsightProvider(type, provider)) return;
      updateRow(
        type,
        insightRunOptionsForProvider(
          type,
          provider,
          preferencesRef.current[type],
          catalog,
        ),
      );
    },
    changeModel: (type, model) => {
      const row = options?.[type];
      if (row === undefined) return;
      updateRow(
        type,
        insightRunOptionsForModel(row.models, model, row.reasoning),
      );
    },
    changeReasoning: (type, reasoning) => {
      const row = options?.[type];
      if (
        row === undefined ||
        !modelReasoningOptions(row.models, row.model).includes(reasoning)
      )
        return;
      updateRow(type, { reasoning });
    },
    changeLanguage: (type, language) => updateRow(type, { language }),
    loadAccountModels: (provider) =>
      loadAccountModels(provider, (nextCatalog) =>
        setOptions((current) => {
          if (current === undefined) return current;
          const reseed = (type: InsightRunType): RunInsightsRowOptions =>
            current[type].provider === provider &&
            !latestRunState.current.runs[type].busy &&
            latestRunState.current.statuses[type] !== "running"
              ? {
                  ...current[type],
                  ...insightRunOptionsForProvider(
                    type,
                    provider,
                    { ...current[type], model: current[type].model ?? "" },
                    nextCatalog,
                  ),
                }
              : current[type];
          return {
            brief: reseed("brief"),
            guide: reseed("guide"),
            walkthrough: reseed("walkthrough"),
            analysis: reseed("analysis"),
          };
        }),
      ),
    starting:
      rows !== undefined &&
      RUN_INSIGHTS_ORDER.some((type) => runs[type].starting),
    start,
  };
}
