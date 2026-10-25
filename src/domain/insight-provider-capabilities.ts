import type { InsightType } from "./insight-record";
import {
  ACCOUNT_INSIGHT_PROVIDERS,
  type InsightProvider,
} from "./insight-provider";

/** Implementation support only; executable discovery and model readiness are separate checks. */
const INSIGHT_PROVIDER_SUPPORT = {
  brief: { pi: false, "codex-cli-account": true, "pi-cli-account": true },
  analysis: { pi: false, "codex-cli-account": true, "pi-cli-account": true },
  guide: { pi: false, "codex-cli-account": true, "pi-cli-account": true },
  walkthrough: {
    pi: false,
    "codex-cli-account": true,
    "pi-cli-account": true,
  },
} as const satisfies Record<InsightType, Record<InsightProvider, boolean>>;

/** A cached model or installed CLI cannot enable an unimplemented Insight producer. */
export function supportsInsightProvider(
  type: InsightType,
  provider: InsightProvider,
): boolean {
  return INSIGHT_PROVIDER_SUPPORT[type][provider];
}

/** Provider picker order is stable across single and multi-Insight dialogs. */
export function supportedInsightProviders(
  type: InsightType,
): ReadonlyArray<InsightProvider> {
  return ACCOUNT_INSIGHT_PROVIDERS.filter((provider) =>
    supportsInsightProvider(type, provider),
  );
}

/** Projects implementation support into the provider catalog without starting a provider. */
export function supportedInsightTypes(
  provider: InsightProvider,
): ReadonlyArray<InsightType> {
  const types = [
    "brief",
    "analysis",
    "guide",
    "walkthrough",
  ] as const satisfies ReadonlyArray<InsightType>;
  return types.filter((type) => supportsInsightProvider(type, provider));
}
