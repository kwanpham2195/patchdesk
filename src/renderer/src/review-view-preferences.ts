import * as v from "valibot";

import { definePreference } from "./lib/local-preference";

export type ReviewViewPreferences = {
  readonly diffStyle: "unified" | "split";
  readonly fileMode: "all" | "selected";
  readonly overflow: "scroll" | "wrap";
};

export const DEFAULT_REVIEW_VIEW_PREFERENCES: ReviewViewPreferences = {
  diffStyle: "unified",
  fileMode: "all",
  overflow: "scroll",
};

const STORAGE_VERSION = 1;

// Every field falls back independently, matching inbox-view-preferences.ts:
// one stale or hand-edited field resets itself instead of discarding the
// whole stored record.
const preferencesSchema = v.object({
  diffStyle: v.fallback(v.picklist(["unified", "split"]), "unified"),
  fileMode: v.fallback(v.picklist(["all", "selected"]), "all"),
  overflow: v.fallback(v.picklist(["scroll", "wrap"]), "scroll"),
});

const storedSchema = v.pipe(
  v.object({
    version: v.literal(STORAGE_VERSION),
    preferences: preferencesSchema,
  }),
  v.transform((stored): ReviewViewPreferences => stored.preferences),
);

const reviewViewPreference = definePreference({
  key: (profileId: string) =>
    `patchdesk.review-view.v${STORAGE_VERSION}.${profileId}`,
  schema: storedSchema,
  defaultValue: DEFAULT_REVIEW_VIEW_PREFERENCES,
  encodeStored: (value: ReviewViewPreferences) => ({
    version: STORAGE_VERSION,
    preferences: value,
  }),
});

export function loadReviewViewPreferences(
  profileId: string,
): ReviewViewPreferences {
  return reviewViewPreference.load(profileId);
}

export function saveReviewViewPreferences(
  profileId: string,
  update: Partial<ReviewViewPreferences>,
): ReviewViewPreferences {
  const next = { ...loadReviewViewPreferences(profileId), ...update };
  reviewViewPreference.save(profileId, next);
  return next;
}
