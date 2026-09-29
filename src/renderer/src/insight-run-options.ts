import type {
  InsightLanguage,
  InsightProvider,
  InsightReasoning,
} from "../../domain/insight-provider";
import type {
  InsightProviderCatalog,
  InsightProviderCatalogModel,
} from "./insight-catalog-contracts";
import type { InsightRunPreference } from "./insight-run-preferences";

/** The options one Insight run starts with, as a run dialog shows them. */
export type InsightRunOptions = {
  readonly provider: InsightProvider;
  readonly models: ReadonlyArray<InsightProviderCatalogModel>;
  readonly model: string | null;
  readonly reasoning: InsightReasoning;
  readonly language: InsightLanguage;
};

function providerModels(
  catalog: InsightProviderCatalog | undefined,
  provider: InsightProvider,
): InsightProviderCatalogModel[] {
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
  preference: InsightRunPreference | undefined,
  catalog: InsightProviderCatalog | undefined,
): InsightRunOptions {
  const provider = preference?.provider ?? "pi";
  const models = providerModels(catalog, provider);
  return {
    provider,
    models,
    model:
      preference !== undefined &&
      models.some((candidate) => candidate.id === preference.model)
        ? preference.model
        : (models[0]?.id ?? null),
    reasoning: preference?.reasoning ?? "medium",
    language: preference?.language ?? "en",
  };
}

/** The options after the provider changes: the saved choice when it was for that provider, else its first model. */
export function insightRunOptionsForProvider(
  provider: InsightProvider,
  preference: InsightRunPreference | undefined,
  catalog: InsightProviderCatalog | undefined,
): Pick<InsightRunOptions, "provider" | "models" | "model" | "reasoning"> {
  const models = providerModels(catalog, provider);
  return {
    provider,
    models,
    model:
      preference?.provider === provider &&
      models.some((candidate) => candidate.id === preference.model)
        ? preference.model
        : (models[0]?.id ?? null),
    reasoning:
      preference?.provider === provider
        ? preference.reasoning
        : firstModelReasoning(models),
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
