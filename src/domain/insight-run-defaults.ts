import {
  ACCOUNT_INSIGHT_PROVIDERS,
  type InsightProvenance,
  type InsightProvider,
  type InsightReasoning,
} from "./insight-provider";
import { supportsInsightProvider } from "./insight-provider-capabilities";
import type { InsightType } from "./insight-record";

type InsightRunDefaults = {
  readonly provider: InsightProvider;
  readonly model: string | null;
  readonly reasoning: InsightReasoning;
  readonly selectionNotice: "retired" | "unavailable" | null;
};

/** Only opening defaults may replace an unavailable saved provider; refresh keeps explicit choices. */
export function selectInsightRunDefaults(
  type: InsightType,
  saved: InsightProvenance | undefined,
  catalog:
    | {
        readonly providers: ReadonlyArray<{
          readonly id: InsightProvider;
          readonly available: boolean;
          readonly supportedTypes: ReadonlyArray<InsightType>;
        }>;
        readonly models: ReadonlyArray<{
          readonly provider: InsightProvider;
          readonly id: string;
          readonly reasoning: ReadonlyArray<InsightReasoning>;
          readonly defaultReasoning?: InsightReasoning | undefined;
        }>;
      }
    | undefined,
  recent: ReadonlyArray<InsightProvenance>,
): InsightRunDefaults {
  const available = ACCOUNT_INSIGHT_PROVIDERS.filter(
    (provider) =>
      supportsInsightProvider(type, provider) &&
      catalog?.providers.some(
        (candidate) =>
          candidate.id === provider &&
          candidate.available &&
          candidate.supportedTypes.includes(type),
      ),
  );
  const keepSaved =
    saved !== undefined &&
    available.some((provider) => provider === saved.provider);
  const previous = recent.find((choice) =>
    available.some((provider) => provider === choice.provider),
  );
  const choice = keepSaved ? saved : previous;
  const provider =
    choice?.provider ?? available[0] ?? ACCOUNT_INSIGHT_PROVIDERS[0];
  const models = available.some((candidate) => candidate === provider)
    ? (catalog?.models.filter((candidate) => candidate.provider === provider) ??
      [])
    : [];
  const model =
    models.find((candidate) => candidate.id === choice?.model) ?? models[0];
  const reasoning =
    choice !== undefined &&
    model?.id === choice.model &&
    model.reasoning.includes(choice.reasoning)
      ? choice.reasoning
      : (model?.defaultReasoning ?? model?.reasoning[0] ?? "medium");
  return {
    provider,
    model: model?.id ?? null,
    reasoning,
    selectionNotice:
      saved === undefined || keepSaved
        ? null
        : saved.provider === "pi"
          ? "retired"
          : "unavailable",
  };
}
