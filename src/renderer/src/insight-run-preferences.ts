import * as v from "valibot";

import type {
  InsightProvider,
  InsightReasoning,
} from "../../domain/insight-provider";

export type InsightPreferenceType = "analysis" | "walkthrough";
export type InsightRunPreference = {
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
};

const VERSION = 1;

/** The stored preference record, as `localStorage` hands it back. */
const storedPreferenceSchema = v.object({
  provider: v.picklist(["pi", "codex-cli-account"]),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
});

/** Loads one profile/type Insight preference, rejecting corrupt local storage. */
export function loadInsightRunPreference(
  profileId: string,
  type: InsightPreferenceType,
): InsightRunPreference | undefined {
  try {
    const parsed = v.safeParse(
      storedPreferenceSchema,
      JSON.parse(window.localStorage.getItem(key(profileId, type)) ?? "null"),
    );
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** Saves one non-secret profile/type Insight preference. */
export function saveInsightRunPreference(
  profileId: string,
  type: InsightPreferenceType,
  preference: InsightRunPreference,
): void {
  window.localStorage.setItem(key(profileId, type), JSON.stringify(preference));
}

function key(profileId: string, type: InsightPreferenceType): string {
  return `patchdesk.insight-run.v${VERSION}.${type}.${profileId}`;
}
