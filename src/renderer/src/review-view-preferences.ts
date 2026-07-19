export type ReviewViewPreferences = {
  readonly density: "compact" | "comfortable";
  readonly diffStyle: "unified" | "split";
  readonly fileMode: "all" | "selected";
  readonly overflow: "scroll" | "wrap";
  readonly appRailOpen: boolean;
  readonly reviewRailOpen: boolean;
  readonly detailsRailOpen: boolean;
};

export const DEFAULT_REVIEW_VIEW_PREFERENCES: ReviewViewPreferences = {
  density: "compact",
  diffStyle: "unified",
  fileMode: "all",
  overflow: "scroll",
  appRailOpen: true,
  reviewRailOpen: true,
  detailsRailOpen: true,
};

const STORAGE_VERSION = 1;

export function loadReviewViewPreferences(
  profileId: string,
): ReviewViewPreferences {
  if (typeof window === "undefined") return DEFAULT_REVIEW_VIEW_PREFERENCES;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(storageKey(profileId)) ?? "null",
    ) as unknown;
    return parsePreferences(value);
  } catch {
    return DEFAULT_REVIEW_VIEW_PREFERENCES;
  }
}

export function saveReviewViewPreferences(
  profileId: string,
  update: Partial<ReviewViewPreferences>,
): ReviewViewPreferences {
  const next = { ...loadReviewViewPreferences(profileId), ...update };
  window.localStorage.setItem(
    storageKey(profileId),
    JSON.stringify({ version: STORAGE_VERSION, preferences: next }),
  );
  return next;
}

function parsePreferences(value: unknown): ReviewViewPreferences {
  if (!record(value) || value.version !== STORAGE_VERSION) {
    return DEFAULT_REVIEW_VIEW_PREFERENCES;
  }
  const preferences = value.preferences;
  if (!record(preferences)) return DEFAULT_REVIEW_VIEW_PREFERENCES;
  return {
    density: preferences.density === "comfortable" ? "comfortable" : "compact",
    diffStyle: preferences.diffStyle === "split" ? "split" : "unified",
    fileMode: preferences.fileMode === "selected" ? "selected" : "all",
    overflow: preferences.overflow === "wrap" ? "wrap" : "scroll",
    appRailOpen: preferences.appRailOpen !== false,
    reviewRailOpen: preferences.reviewRailOpen !== false,
    detailsRailOpen: preferences.detailsRailOpen !== false,
  };
}

function storageKey(profileId: string): string {
  return `patchdesk.review-view.v${STORAGE_VERSION}.${profileId}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
