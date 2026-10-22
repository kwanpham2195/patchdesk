import { useEffect, useReducer, useRef } from "react";
import * as v from "valibot";

import {
  ACCOUNT_INSIGHT_PROVIDERS,
  type AccountInsightProvider,
  type InsightLanguage,
  type InsightProvider,
  type InsightReasoning,
} from "#src/domain/insight-provider";
import {
  isApiErrorCode,
  PatchdeskApiError,
  requestJson,
} from "#src/renderer/src/api-client";
import {
  INSIGHT_PREFERENCE_TYPES,
  loadInsightRunPreference,
  type InsightPreferenceType,
  type InsightRunPreference,
} from "#src/renderer/src/insight-run-preferences";
import {
  loadAccountModelCache,
  saveAccountModelCache,
} from "#src/renderer/src/account-model-cache";
import {
  parseInsightProviderCatalog,
  type InsightProviderCatalog,
  type InsightProviderCatalogModel,
} from "#src/renderer/src/insight-catalog-contracts";
import {
  insightRunOptionsForProvider,
  seedInsightRunOptions,
} from "#src/renderer/src/insight-run-options";
import { supportsInsightProvider } from "#src/domain/insight-provider-capabilities";
import type { InsightRunDialogType } from "#src/renderer/src/components/insight-run-dialog";

/** Why an account provider's explicit model load failed; `requiredVersion` is set for an outdated pi. */
export type AccountModelsFailure = {
  readonly provider: AccountInsightProvider;
  readonly requiredVersion?: string;
};
/** The route each account provider's explicit Load models action posts to. */
const ACCOUNT_MODELS_PATHS = {
  "codex-cli-account": "/v1/insight-providers/codex/models",
  "pi-cli-account": "/v1/insight-providers/pi-cli/models",
} as const satisfies Record<AccountInsightProvider, string>;
const requiredVersionBodySchema = v.looseObject({
  requiredVersion: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u)),
});
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
  /** The account provider whose explicit model load is in flight; one runs at a time. */
  readonly accountModelsPending: AccountInsightProvider | null;
  readonly accountModelsFailure: AccountModelsFailure | null;
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
  accountModelsPending: null,
  accountModelsFailure: null,
};
function insightRunConfigurationReducer(
  state: InsightRunConfiguration,
  action: InsightRunConfigurationAction,
): InsightRunConfiguration {
  return { ...state, ...action.patch };
}
type CatalogModel = InsightProviderCatalogModel;
/** Replaces every entry of one account provider in a model list, keeping the rest. */
function mergeAccountModels(
  models: ReadonlyArray<CatalogModel>,
  provider: AccountInsightProvider,
  accountModels: ReadonlyArray<CatalogModel>,
): CatalogModel[] {
  return [
    ...models.filter((candidate) => candidate.provider !== provider),
    ...accountModels,
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
  readonly activateAccount: (provider: AccountInsightProvider) => void;
  readonly loadAccountModels: (
    provider: AccountInsightProvider,
    onLoaded: (nextCatalog: InsightProviderCatalog) => void,
  ) => void;
  readonly cancelAccountModels: () => void;
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
  const accountModelsGenerationRef = useRef(0);

  const cancelAccountModels = (): void => {
    accountModelsGenerationRef.current += 1;
    setConfiguration({
      accountModelsPending: null,
      accountModelsFailure: null,
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
    setConfiguration(
      seedInsightRunOptions(initialInsight, initialPreference, undefined),
    );
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
        const catalogWithCache = {
          ...parsed,
          models: ACCOUNT_INSIGHT_PROVIDERS.reduce(
            (models, provider) => {
              const cached = loadAccountModelCache(provider, profileId);
              return cached === undefined
                ? models
                : mergeAccountModels(models, provider, cached);
            },
            [...parsed.models],
          ),
        };
        setConfiguration({
          catalog: catalogWithCache,
          ...seedInsightRunOptions(
            initialInsight,
            initialPreference,
            catalogWithCache,
          ),
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
    if (!supportsInsightProvider(activePreferenceType, nextProvider)) return;
    setConfiguration(
      insightRunOptionsForProvider(
        activePreferenceType,
        nextProvider,
        preferencesRef.current[activePreferenceType],
        catalog,
      ),
    );
  };
  /** Loads one account provider's models into the catalog, then hands the merged catalog to `onLoaded`. */
  const loadAccountModels = (
    provider: AccountInsightProvider,
    onLoaded: (nextCatalog: InsightProviderCatalog) => void,
  ): void => {
    const generation = accountModelsGenerationRef.current + 1;
    accountModelsGenerationRef.current = generation;
    setConfiguration({
      accountModelsPending: provider,
      accountModelsFailure: null,
    });
    void requestJson(ACCOUNT_MODELS_PATHS[provider], {
      method: "POST",
      body: {},
    })
      .then((value) => {
        if (accountModelsGenerationRef.current !== generation) return;
        const parsed = parseInsightProviderCatalog(value);
        if (parsed === undefined)
          throw new Error("Invalid account provider catalog");
        const accountModels = parsed.models.filter(
          (candidate) => candidate.provider === provider,
        );
        const nextCatalog =
          catalog === undefined
            ? parsed
            : {
                ...catalog,
                providers: [
                  ...catalog.providers.filter(
                    (candidate) => candidate.id !== provider,
                  ),
                  ...parsed.providers,
                ],
                models: mergeAccountModels(
                  catalog.models,
                  provider,
                  accountModels,
                ),
              };
        saveAccountModelCache(provider, profileId, accountModels);
        setConfiguration({ catalog: nextCatalog });
        onLoaded(nextCatalog);
      })
      .catch((cause: unknown) => {
        if (accountModelsGenerationRef.current !== generation) return;
        if (isApiErrorCode(cause, "cancelled")) return;
        const body =
          cause instanceof PatchdeskApiError
            ? v.safeParse(requiredVersionBodySchema, cause.responseBody)
            : undefined;
        setConfiguration({
          accountModelsFailure:
            body?.success === true
              ? { provider, requiredVersion: body.output.requiredVersion }
              : { provider },
        });
      })
      .finally(() => {
        if (accountModelsGenerationRef.current !== generation) return;
        setConfiguration({ accountModelsPending: null });
      });
  };
  const activateAccount = (provider: AccountInsightProvider): void => {
    if (!supportsInsightProvider(activePreferenceType, provider)) return;
    loadAccountModels(provider, (nextCatalog) =>
      setConfiguration(
        insightRunOptionsForProvider(
          activePreferenceType,
          provider,
          preferencesRef.current[activePreferenceType],
          nextCatalog,
        ),
      ),
    );
  };
  return {
    configuration,
    preferencesRef,
    setConfiguration,
    changeProvider,
    activateAccount,
    loadAccountModels,
    cancelAccountModels,
  };
}
