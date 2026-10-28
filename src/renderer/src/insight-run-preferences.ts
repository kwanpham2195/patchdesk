import * as v from "valibot";

import {
  ACCOUNT_INSIGHT_PROVIDERS,
  isAccountInsightProvider,
  INSIGHT_LANGUAGES,
  INSIGHT_PROVIDERS,
  type InsightLanguage,
  type InsightProvider,
  type InsightReasoning,
} from "#src/domain/insight-provider";
import { definePreference } from "./lib/local-preference";

/** Every Insight type that stores its own provider/model/reasoning/language choice. */
export const INSIGHT_PREFERENCE_TYPES = [
  "analysis",
  "walkthrough",
  "brief",
  "guide",
] as const;
export type InsightPreferenceType = (typeof INSIGHT_PREFERENCE_TYPES)[number];
export type InsightRunPreference = {
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
  readonly language: InsightLanguage;
};

const VERSION = 1;

/** The stored preference record, as `localStorage` hands it back. */
const storedPreferenceSchema = v.object({
  provider: v.picklist(INSIGHT_PROVIDERS),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
  // A choice saved before Insights had a language keeps its model and reads as English.
  language: v.optional(v.picklist(INSIGHT_LANGUAGES), "en"),
});

// A stored record is one provider/model/reasoning choice; a field that no
// longer parses makes the remaining two meaningless, so the record rejects as
// a whole and the caller picks a default from the live provider catalog.
const insightRunPreference = definePreference({
  key: (scope: {
    readonly profileId: string;
    readonly type: InsightPreferenceType;
  }) => `patchdesk.insight-run.v${VERSION}.${scope.type}.${scope.profileId}`,
  schema: storedPreferenceSchema,
  defaultValue: undefined,
});

/** Loads one profile/type Insight preference, rejecting corrupt local storage. */
export function loadInsightRunPreference(
  profileId: string,
  type: InsightPreferenceType,
): InsightRunPreference | undefined {
  return insightRunPreference.load({ profileId, type });
}

/** Saves one non-secret profile/type Insight preference. */
export function saveInsightRunPreference(
  profileId: string,
  type: InsightPreferenceType,
  preference: InsightRunPreference,
): void {
  insightRunPreference.save({ profileId, type }, preference);
  if (isAccountInsightProvider(preference.provider)) {
    recentNativePreferences.save(profileId, [
      { ...preference, provider: preference.provider },
      ...recentNativePreferences
        .load(profileId)
        .filter((choice) => choice.provider !== preference.provider),
    ]);
  }
}

// Each account keeps its latest accepted choice, ordered most recent first.
const recentNativePreferences = definePreference({
  key: (profileId: string) => `patchdesk.insight-recent-native.v1.${profileId}`,
  schema: v.pipe(
    v.array(
      v.object({
        ...storedPreferenceSchema.entries,
        provider: v.picklist(ACCOUNT_INSIGHT_PROVIDERS),
      }),
    ),
    v.maxLength(ACCOUNT_INSIGHT_PROVIDERS.length),
  ),
  defaultValue: [],
});

/** Accepted starts order native choices within the active workspace profile. */
export function loadRecentNativeInsightPreferences(
  profileId: string,
): ReadonlyArray<InsightRunPreference> {
  return recentNativePreferences.load(profileId);
}
