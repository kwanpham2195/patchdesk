import { INSIGHT_PROVIDER_LABELS } from "./insight-contracts";
import type { InsightProviderCatalogModel } from "./insight-catalog-contracts";
import type { InsightType } from "#src/domain/insight-record";
import {
  isAccountInsightProvider,
  type InsightProvider,
} from "#src/domain/insight-provider";

/** Only paged account runs need the native billing-count disclosure. */
export function insightNativeRunDisclosure(
  type: InsightType,
  provider: InsightProvider,
): string | undefined {
  return isAccountInsightProvider(provider) &&
    ["guide", "walkthrough"].includes(type)
    ? "Patchdesk records native turn starts, not exact provider requests or billable counts."
    : undefined;
}

/** The visible account and model identity shared by Start and batch row summaries. */
export function insightRunSelectionLabel(
  provider: InsightProvider,
  models: ReadonlyArray<Pick<InsightProviderCatalogModel, "id" | "label">>,
  model: string | null,
): string {
  const label = models.find((candidate) => candidate.id === model)?.label;
  return `${INSIGHT_PROVIDER_LABELS[provider]} · ${label ?? model ?? "No model selected"}`;
}
