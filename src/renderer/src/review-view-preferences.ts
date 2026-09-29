import * as v from "valibot";

import { definePreference } from "./lib/local-preference";

export type ReviewViewPreferences = {
  readonly diffStyle: "unified" | "split";
  readonly fileMode: "all" | "selected";
  readonly overflow: "scroll" | "wrap";
  readonly lineNumbers: boolean;
  readonly backgrounds: boolean;
};

export const DEFAULT_REVIEW_VIEW_PREFERENCES: ReviewViewPreferences = {
  diffStyle: "unified",
  fileMode: "all",
  overflow: "wrap",
  lineNumbers: true,
  backgrounds: true,
};

const STORAGE_VERSION = 1;

// Every field falls back independently, matching inbox-view-preferences.ts:
// one stale or hand-edited field resets itself instead of discarding the
// whole stored record.
const preferencesSchema = v.object({
  diffStyle: v.fallback(v.picklist(["unified", "split"]), "unified"),
  fileMode: v.fallback(v.picklist(["all", "selected"]), "all"),
  overflow: v.fallback(v.picklist(["scroll", "wrap"]), "wrap"),
  lineNumbers: v.fallback(v.boolean(), true),
  backgrounds: v.fallback(v.boolean(), true),
});

const storedSchema = v.pipe(
  v.object({
    version: v.literal(STORAGE_VERSION),
    preferences: preferencesSchema,
  }),
  v.transform((stored): ReviewViewPreferences => stored.preferences),
);

// One key for the whole app: these are the reviewer's display preferences,
// so every workspace profile shares them. The older per-profile keys,
// `patchdesk.review-view.v1.<profileId>`, stay in storage unread (#553).
const reviewViewPreference = definePreference({
  key: `patchdesk.review-view.v${STORAGE_VERSION}`,
  schema: storedSchema,
  defaultValue: DEFAULT_REVIEW_VIEW_PREFERENCES,
  encodeStored: (value: ReviewViewPreferences) => ({
    version: STORAGE_VERSION,
    preferences: value,
  }),
});

export function loadReviewViewPreferences(): ReviewViewPreferences {
  return reviewViewPreference.load();
}

export function saveReviewViewPreferences(
  update: Partial<ReviewViewPreferences>,
): ReviewViewPreferences {
  const next = { ...loadReviewViewPreferences(), ...update };
  reviewViewPreference.save(undefined, next);
  return next;
}
