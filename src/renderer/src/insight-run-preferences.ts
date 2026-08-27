import * as v from "valibot";

import type {
  InsightProvider,
  InsightReasoning,
} from "../../domain/insight-provider";
import { definePreference } from "./lib/local-preference";

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
}
