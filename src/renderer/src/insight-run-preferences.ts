import type { InsightProvider, InsightReasoning } from "../../domain/insight-provider";

export type InsightPreferenceType = "analysis" | "walkthrough";
export type InsightRunPreference = {
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
};

const VERSION = 1;

/** Loads one profile/type Insight preference, rejecting corrupt local storage. */
export function loadInsightRunPreference(profileId: string, type: InsightPreferenceType): InsightRunPreference | undefined {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key(profileId, type)) ?? "null");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const provider = "provider" in raw ? raw.provider : undefined;
    const model = "model" in raw ? raw.model : undefined;
    const reasoning = "reasoning" in raw ? raw.reasoning : undefined;
    if ((provider !== "pi" && provider !== "codex-cli-account") || typeof model !== "string" || model.length < 1 || model.length > 200) return undefined;
    if (reasoning !== "minimal" && reasoning !== "low" && reasoning !== "medium" && reasoning !== "high" && reasoning !== "xhigh") return undefined;
    return { provider, model, reasoning };
  } catch {
    return undefined;
  }
}

/** Saves one non-secret profile/type Insight preference. */
export function saveInsightRunPreference(profileId: string, type: InsightPreferenceType, preference: InsightRunPreference): void {
  window.localStorage.setItem(key(profileId, type), JSON.stringify(preference));
}

function key(profileId: string, type: InsightPreferenceType): string {
  return `patchdesk.insight-run.v${VERSION}.${type}.${profileId}`;
}
