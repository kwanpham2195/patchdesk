import * as v from "valibot";

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

const storedSchema = v.object({
  version: v.literal(STORAGE_VERSION),
  preferences: preferencesSchema,
});

export function loadReviewViewPreferences(
  profileId: string,
): ReviewViewPreferences {
  const stored = globalThis.window?.localStorage.getItem(storageKey(profileId));
  if (stored === null || stored === undefined)
    return DEFAULT_REVIEW_VIEW_PREFERENCES;
  try {
    const parsed = v.safeParse(storedSchema, JSON.parse(stored));
    return parsed.success
      ? parsed.output.preferences
      : DEFAULT_REVIEW_VIEW_PREFERENCES;
  } catch {
    return DEFAULT_REVIEW_VIEW_PREFERENCES;
  }
}

export function saveReviewViewPreferences(
  profileId: string,
  update: Partial<ReviewViewPreferences>,
): ReviewViewPreferences {
  const next = { ...loadReviewViewPreferences(profileId), ...update };
  globalThis.window?.localStorage.setItem(
    storageKey(profileId),
    JSON.stringify({ version: STORAGE_VERSION, preferences: next }),
  );
  return next;
}

function storageKey(profileId: string): string {
  return `patchdesk.review-view.v${STORAGE_VERSION}.${profileId}`;
}
