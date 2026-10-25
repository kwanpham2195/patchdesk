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
