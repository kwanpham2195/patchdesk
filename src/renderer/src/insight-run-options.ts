import type {
  InsightLanguage,
  InsightProvider,
  InsightReasoning,
} from "#src/domain/insight-provider";
import type {
  InsightProviderCatalog,
  InsightProviderCatalogModel,
} from "./insight-catalog-contracts";
import type { InsightRunPreference } from "./insight-run-preferences";
import type { InsightType } from "#src/domain/insight-record";
import { supportsInsightProvider } from "#src/domain/insight-provider-capabilities";

/** The options one Insight run starts with, as a run dialog shows them. */
export type InsightRunOptions = {
  readonly provider: InsightProvider;
  readonly models: ReadonlyArray<InsightProviderCatalogModel>;
  readonly model: string | null;
  readonly reasoning: InsightReasoning;
  readonly language: InsightLanguage;
};

function providerModels(
  type: InsightType,
  catalog: InsightProviderCatalog | undefined,
  provider: InsightProvider,
): InsightProviderCatalogModel[] {
  if (
    !supportsInsightProvider(type, provider) ||
    !catalog?.providers.some(
      (candidate) =>
        candidate.id === provider &&
        candidate.available &&
        candidate.supportedTypes.includes(type),
    )
  )
    return [];
  return (
    catalog?.models.filter((candidate) => candidate.provider === provider) ?? []
  );
}

function firstModelReasoning(
  models: ReadonlyArray<InsightProviderCatalogModel>,
): InsightReasoning {
  const first = models[0];
  return first?.defaultReasoning ?? first?.reasoning[0] ?? "medium";
}

/** The options a run dialog opens with: the type's saved choice where the catalog still offers its model. */
export function seedInsightRunOptions(
  type: InsightType,
  preference: InsightRunPreference | undefined,
  catalog: InsightProviderCatalog | undefined,
): InsightRunOptions {
  const saved = preference;
  const provider =
    saved?.provider ??
    catalog?.providers.find(
      (candidate) =>
        candidate.available &&
        candidate.supportedTypes.includes(type) &&
        supportsInsightProvider(type, candidate.id),
    )?.id ??
    "pi";
  const models = providerModels(type, catalog, provider);
  return {
    provider,
    models,
    model:
      saved !== undefined &&
      models.some((candidate) => candidate.id === saved.model)
        ? saved.model
        : (models[0]?.id ?? null),
    reasoning: saved?.reasoning ?? firstModelReasoning(models),
    language: preference?.language ?? "en",
  };
}

/** The options after the provider changes: the saved choice when it was for that provider, else its first model. */
export function insightRunOptionsForProvider(
  type: InsightType,
  provider: InsightProvider,
  preference: InsightRunPreference | undefined,
  catalog: InsightProviderCatalog | undefined,
): Pick<InsightRunOptions, "provider" | "models" | "model" | "reasoning"> {
  const models = providerModels(type, catalog, provider);
  const model =
    preference?.provider === provider &&
    models.some((candidate) => candidate.id === preference.model)
      ? preference.model
      : (models[0]?.id ?? null);
  return {
    provider,
    models,
    ...insightRunOptionsForModel(
      models,
      model,
      preference?.provider === provider
        ? preference.reasoning
        : firstModelReasoning(models),
    ),
  };
}

/** The model and reasoning after a model change; reasoning the new model does not support falls back to its first level. */
export function insightRunOptionsForModel(
  models: ReadonlyArray<{
    readonly id: string;
    readonly reasoning?: ReadonlyArray<InsightReasoning>;
  }>,
  model: string | null,
  reasoning: InsightReasoning,
): Pick<InsightRunOptions, "model" | "reasoning"> {
  const selected = models.find((candidate) => candidate.id === model);
  if (
    selected?.reasoning !== undefined &&
    !selected.reasoning.includes(reasoning)
  )
    return { model, reasoning: selected.reasoning[0] ?? "medium" };
  return { model, reasoning };
}

/** The reasoning levels the chosen model supports; a model that lists none offers the common three. */
export function modelReasoningOptions(
  models: ReadonlyArray<{
    readonly id: string;
    readonly reasoning?: ReadonlyArray<InsightReasoning>;
  }>,
  model: string | null,
): ReadonlyArray<InsightReasoning> {
  return (
    models.find((candidate) => candidate.id === model)?.reasoning ?? [
      "low",
      "medium",
      "high",
    ]
  );
}
