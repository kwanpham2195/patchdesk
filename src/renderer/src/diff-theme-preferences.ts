import {
  PIERRE_DARK_THEMES,
  PIERRE_LIGHT_THEMES,
  type PierreThemeOption,
} from "./pierre-theme-catalog";

export type DiffThemeOption = PierreThemeOption;
export const DIFF_LIGHT_THEMES = PIERRE_LIGHT_THEMES;
export const DIFF_DARK_THEMES = PIERRE_DARK_THEMES;

export type DiffThemePreferences = {
  readonly light: string;
  readonly dark: string;
};

export const DEFAULT_DIFF_THEME_PREFERENCES: DiffThemePreferences = {
  light: "pierre-light",
  dark: "pierre-dark",
};

const storageKey = "patchdesk.diff-theme.v2";
const legacyStorageKey = "patchdesk.diff-theme.v1";

export type SaveDiffThemePreferencesResult =
  | { readonly saved: true; readonly preferences: DiffThemePreferences }
  | { readonly saved: false; readonly preferences: DiffThemePreferences };

function hasTheme(
  themes: ReadonlyArray<DiffThemeOption>,
  value: unknown,
): value is string {
  return typeof value === "string" && themes.some((theme) => theme.id === value);
}

export function parseDiffThemePreferences(value: unknown): DiffThemePreferences {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_DIFF_THEME_PREFERENCES;
  }
  const candidate = value as Record<string, unknown>;
  return {
    light: hasTheme(DIFF_LIGHT_THEMES, candidate.light)
      ? candidate.light
      : DEFAULT_DIFF_THEME_PREFERENCES.light,
    dark: hasTheme(DIFF_DARK_THEMES, candidate.dark)
      ? candidate.dark
      : DEFAULT_DIFF_THEME_PREFERENCES.dark,
  };
}

export function loadDiffThemePreferences(): DiffThemePreferences {
  if (typeof window === "undefined") return DEFAULT_DIFF_THEME_PREFERENCES;
  try {
    const serialized = window.localStorage.getItem(storageKey);
    if (serialized !== null) return parseDiffThemePreferences(JSON.parse(serialized));

    const legacy = parseLegacyDiffThemePreference(window.localStorage.getItem(legacyStorageKey));
    if (legacy === undefined) return DEFAULT_DIFF_THEME_PREFERENCES;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(legacy));
      window.localStorage.removeItem(legacyStorageKey);
    } catch {
      // Keep v1 intact when storage is unavailable. The current render can
      // still use its valid migrated pair without pretending it was saved.
    }
    return legacy;
  } catch {
    return DEFAULT_DIFF_THEME_PREFERENCES;
  }
}

export function saveDiffThemePreferences(value: DiffThemePreferences): SaveDiffThemePreferencesResult {
  const preferences = parseDiffThemePreferences(value);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(preferences));
    window.dispatchEvent(
      new CustomEvent<DiffThemePreferences>("patchdesk:diff-theme", {
        detail: preferences,
      }),
    );
    return { saved: true, preferences };
  } catch {
    return { saved: false, preferences };
  }
}

export function diffThemeFor(
  preferences: DiffThemePreferences,
): DiffThemePreferences {
  return preferences;
}

function parseLegacyDiffThemePreference(value: string | null): DiffThemePreferences | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === "github") return { light: "github-light", dark: "github-dark" };
    if (parsed === "high_contrast") {
      return {
        light: "github-light-high-contrast",
        dark: "github-dark-high-contrast",
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const family = (parsed as Record<string, unknown>).family;
    if (family === "github") return { light: "github-light", dark: "github-dark" };
    if (family === "high_contrast") {
      return {
        light: "github-light-high-contrast",
        dark: "github-dark-high-contrast",
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
