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
  light: "github-light",
  dark: "github-dark",
};

// The pierre pair was the default before GitHub; profiles that persisted it
// explicitly should adopt the improved defaults too, while any other explicit
// theme choice stays untouched.
const RETIRED_DIFF_THEME_PREFERENCES: DiffThemePreferences = {
  light: "pierre-light",
  dark: "pierre-dark",
};

const storageKey = "patchdesk.diff-theme.v2";
const legacyStorageKey = "patchdesk.diff-theme.v1";

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
  const parsed: DiffThemePreferences = {
    light: hasTheme(DIFF_LIGHT_THEMES, candidate.light)
      ? candidate.light
      : DEFAULT_DIFF_THEME_PREFERENCES.light,
    dark: hasTheme(DIFF_DARK_THEMES, candidate.dark)
      ? candidate.dark
      : DEFAULT_DIFF_THEME_PREFERENCES.dark,
  };
  if (
    parsed.light === RETIRED_DIFF_THEME_PREFERENCES.light &&
    parsed.dark === RETIRED_DIFF_THEME_PREFERENCES.dark
  ) {
    return DEFAULT_DIFF_THEME_PREFERENCES;
  }
  return parsed;
}

export function loadDiffThemePreferences(): DiffThemePreferences {
  if (typeof window === "undefined") return DEFAULT_DIFF_THEME_PREFERENCES;
  try {
    const serialized = window.localStorage.getItem(storageKey);
    // parseDiffThemePreferences migrates the retired {pierre-light,
    // pierre-dark} default pair to the GitHub defaults here, so profiles that
    // persisted the previous default adopt the improvement without clearing
    // storage; explicit custom pairs are returned unchanged.
    if (serialized !== null) return parseDiffThemePreferences(JSON.parse(serialized));

    const legacy = parseLegacyDiffThemePreference(window.localStorage.getItem(legacyStorageKey));
    return legacy ?? DEFAULT_DIFF_THEME_PREFERENCES;
  } catch {
    return DEFAULT_DIFF_THEME_PREFERENCES;
  }
}

/** Removes legacy renderer preferences after config.json accepts the migration. */
export function clearDiffThemePreferences(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem(legacyStorageKey);
  } catch {
    // Config is already durable; leave the legacy values for a later cleanup.
  }
}

/** Announces an already-persisted preference change to mounted diff views. */
export function applyDiffThemePreferences(value: DiffThemePreferences): void {
  window.dispatchEvent(
    new CustomEvent<DiffThemePreferences>("patchdesk:diff-theme", {
      detail: value,
    }),
  );
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
