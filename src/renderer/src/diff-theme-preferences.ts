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
  const serialized = window.localStorage.getItem(storageKey);
  if (serialized === null) return DEFAULT_DIFF_THEME_PREFERENCES;
  try {
    return parseDiffThemePreferences(JSON.parse(serialized));
  } catch {
    return DEFAULT_DIFF_THEME_PREFERENCES;
  }
}

export function saveDiffThemePreferences(value: DiffThemePreferences): void {
  const preferences = parseDiffThemePreferences(value);
  window.localStorage.setItem(storageKey, JSON.stringify(preferences));
  window.dispatchEvent(
    new CustomEvent<DiffThemePreferences>("patchdesk:diff-theme", {
      detail: preferences,
    }),
  );
}

export function diffThemeFor(
  preferences: DiffThemePreferences,
  appearance: "light" | "dark",
): string {
  return appearance === "light" ? preferences.light : preferences.dark;
}
