import { useEffect, useReducer, useRef } from "react";

import type {
  InsightLanguage,
  InsightProvider,
  InsightReasoning,
} from "../../../domain/insight-provider";
import { isApiErrorCode, requestJson } from "../api-client";
import {
  INSIGHT_PREFERENCE_TYPES,
  loadInsightRunPreference,
  type InsightPreferenceType,
  type InsightRunPreference,
} from "../insight-run-preferences";
import { loadCodexModelCache, saveCodexModelCache } from "../codex-model-cache";
import {
  parseInsightProviderCatalog,
  type InsightProviderCatalogModel,
} from "../insight-catalog-contracts";
import type { InsightRunDialogType } from "../components/insight-run-dialog";

type InsightModelOption = {
  readonly id: string;
  readonly label: string;
  readonly reasoning?: ReadonlyArray<InsightReasoning>;
  readonly cost?: InsightProviderCatalogModel["cost"];
};
export type InsightRunConfiguration = {
  readonly catalog?: ReturnType<typeof parseInsightProviderCatalog>;
  readonly provider: InsightProvider;
  readonly models: ReadonlyArray<InsightModelOption>;
  readonly model: string | null;
  readonly reasoning: InsightReasoning;
  readonly language: InsightLanguage;
  readonly runDialogType: InsightRunDialogType | null;
  readonly runDialogAction: "run" | "retry" | "regenerate";
  readonly catalogError: boolean;
  readonly codexActivationPending: boolean;
  readonly codexActivationError: boolean;
};
type InsightRunConfigurationAction = {
  readonly type: "updated";
  readonly patch: Partial<InsightRunConfiguration>;
};
const initialInsightRunConfiguration: InsightRunConfiguration = {
  provider: "pi",
  models: [],
  model: null,
  reasoning: "medium",
  language: "en",
  runDialogType: null,
  runDialogAction: "run",
  catalogError: false,
  codexActivationPending: false,
  codexActivationError: false,
};
function insightRunConfigurationReducer(
  state: InsightRunConfiguration,
  action: InsightRunConfigurationAction,
): InsightRunConfiguration {
  return { ...state, ...action.patch };
}
type CatalogModel = InsightProviderCatalogModel;
/** Replaces every `codex-cli-account` entry in a model list, keeping the rest. */
function mergeCodexModels(
  models: ReadonlyArray<CatalogModel>,
  codexModels: ReadonlyArray<CatalogModel>,
): CatalogModel[] {
  return [
    ...models.filter((candidate) => candidate.provider !== "codex-cli-account"),
    ...codexModels,
  ];
}
type InsightRunPreferences = Partial<
  Record<InsightPreferenceType, InsightRunPreference>
>;
type InsightConfigurationController = {
  readonly configuration: InsightRunConfiguration;
  readonly preferencesRef: React.MutableRefObject<InsightRunPreferences>;
  readonly setConfiguration: (patch: Partial<InsightRunConfiguration>) => void;
  readonly changeProvider: (provider: InsightProvider) => void;
  readonly activateCodex: () => void;
  readonly cancelCodexActivation: () => void;
};
export function useInsightConfiguration(input: {
  readonly profileId: string;
  readonly initialInsight: InsightRunDialogType;
  readonly selectedInsight: InsightRunDialogType;
}): InsightConfigurationController {
  const { profileId, initialInsight, selectedInsight } = input;
  const [configuration, updateConfiguration] = useReducer(
    insightRunConfigurationReducer,
    initialInsightRunConfiguration,
  );
  const { catalog, runDialogType } = configuration;
  const setConfiguration = (patch: Partial<InsightRunConfiguration>): void =>
    updateConfiguration({ type: "updated", patch });
  const preferencesRef = useRef<InsightRunPreferences>({});
  const codexActivationGenerationRef = useRef(0);

  const cancelCodexActivation = (): void => {
    codexActivationGenerationRef.current += 1;
    setConfiguration({
      codexActivationPending: false,
      codexActivationError: false,
    });
  };

  useEffect(() => {
    let active = true;
    const loadedPreferences: InsightRunPreferences = {};
    for (const type of INSIGHT_PREFERENCE_TYPES) {
      const stored = loadInsightRunPreference(profileId, type);
      if (stored !== undefined) loadedPreferences[type] = stored;
    }
    preferencesRef.current = loadedPreferences;
    const initialPreference = loadedPreferences[initialInsight];
    if (initialPreference !== undefined) {
      setConfiguration({
        provider: initialPreference.provider,
        reasoning: initialPreference.reasoning,
        model: initialPreference.model,
        language: initialPreference.language,
      });
    }
    void requestJson("/v1/insight-providers")
      .then((value) => {
        if (!active) return;
        const parsed = parseInsightProviderCatalog(value);
        if (parsed === undefined) {
          setConfiguration({
            catalog: undefined,
            models: [],
            model: null,
            catalogError: true,
          });
          return;
        }
        const piModels = parsed.models.filter(
          (candidate) => candidate.provider === "pi",
        );
        const selectedModel =
          initialPreference?.provider === "pi" &&
          piModels.some((candidate) => candidate.id === initialPreference.model)
            ? initialPreference.model
            : (piModels[0]?.id ?? null);
        const cachedCodexModels = loadCodexModelCache(profileId);
        const catalogWithCache =
          cachedCodexModels === undefined
            ? parsed
            : {
                ...parsed,
                models: mergeCodexModels(parsed.models, cachedCodexModels),
              };
        setConfiguration({
          catalog: catalogWithCache,
          models: piModels,
          model: selectedModel,
          catalogError: false,
        });
      })
      .catch(() => {
        if (!active) return;
        setConfiguration({
          catalog: undefined,
          models: [],
          model: null,
          catalogError: true,
        });
      });
    return () => {
      active = false;
    };
  }, [profileId, initialInsight]);

  const activePreferenceType = runDialogType ?? selectedInsight;
  const changeProvider = (nextProvider: InsightProvider): void => {
    const nextModels =
      catalog?.models.filter(
        (candidate) => candidate.provider === nextProvider,
      ) ?? [];
    const preference = preferencesRef.current[activePreferenceType];
    const first = nextModels[0];
    setConfiguration({
      provider: nextProvider,
      models: nextModels,
      model:
        preference?.provider === nextProvider &&
        nextModels.some((candidate) => candidate.id === preference.model)
          ? preference.model
          : (nextModels[0]?.id ?? null),
      reasoning:
        preference?.provider === nextProvider
          ? preference.reasoning
          : (first?.defaultReasoning ?? first?.reasoning[0] ?? "medium"),
    });
  };
  const activateCodex = (): void => {
    const generation = codexActivationGenerationRef.current + 1;
    codexActivationGenerationRef.current = generation;
    setConfiguration({
      codexActivationPending: true,
      codexActivationError: false,
    });
    void requestJson("/v1/insight-providers/codex/models", {
      method: "POST",
      body: {},
    })
      .then((value) => {
        if (codexActivationGenerationRef.current !== generation) return;
        const parsed = parseInsightProviderCatalog(value);
        if (parsed === undefined) throw new Error("Invalid Codex catalog");
        const nextCatalog =
          catalog === undefined
            ? parsed
            : {
                ...catalog,
                providers: [
                  ...catalog.providers.filter(
                    (candidate) => candidate.id !== "codex-cli-account",
                  ),
                  ...parsed.providers,
                ],
                models: mergeCodexModels(catalog.models, parsed.models),
              };
        const codexModels = parsed.models.filter(
          (candidate) => candidate.provider === "codex-cli-account",
        );
        saveCodexModelCache(profileId, codexModels);
        const preference = preferencesRef.current[activePreferenceType];
        const first = codexModels[0];
        setConfiguration({
          catalog: nextCatalog,
          models: codexModels,
          model:
            preference?.provider === "codex-cli-account" &&
            codexModels.some((candidate) => candidate.id === preference.model)
              ? preference.model
              : (first?.id ?? null),
          reasoning:
            preference?.provider === "codex-cli-account"
              ? preference.reasoning
              : (first?.defaultReasoning ?? first?.reasoning[0] ?? "medium"),
        });
      })
      .catch((cause: unknown) => {
        if (codexActivationGenerationRef.current !== generation) return;
        if (isApiErrorCode(cause, "cancelled")) return;
        setConfiguration({ codexActivationError: true });
      })
      .finally(() => {
        if (codexActivationGenerationRef.current !== generation) return;
        setConfiguration({ codexActivationPending: false });
      });
  };
  return {
    configuration,
    preferencesRef,
    setConfiguration,
    changeProvider,
    activateCodex,
    cancelCodexActivation,
  };
}
