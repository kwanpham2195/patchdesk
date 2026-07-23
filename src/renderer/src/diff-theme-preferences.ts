export type DiffThemeOption = {
  readonly id: string;
  readonly label: string;
};

// This is the complete theme catalog bundled by @pierre/theming 0.0.2. Keep
// it explicit so local storage can never select an arbitrary dynamic import.
export const DIFF_LIGHT_THEMES: ReadonlyArray<DiffThemeOption> = [
  ["pierre-light", "Pierre light"],
  ["pierre-light-soft", "Pierre light soft"],
  ["pierre-light-vibrant", "Pierre light vibrant"],
  ["pierre-light-protanopia-deuteranopia", "Pierre light protanopia/deuteranopia"],
  ["pierre-light-tritanopia", "Pierre light tritanopia"],
  ["ayu-light", "Ayu light"],
  ["catppuccin-latte", "Catppuccin latte"],
  ["everforest-light", "Everforest light"],
  ["github-light", "GitHub light"],
  ["github-light-default", "GitHub light default"],
  ["github-light-high-contrast", "GitHub light high contrast"],
  ["gruvbox-light-hard", "Gruvbox light hard"],
  ["gruvbox-light-medium", "Gruvbox light medium"],
  ["gruvbox-light-soft", "Gruvbox light soft"],
  ["horizon-bright", "Horizon bright"],
  ["kanagawa-lotus", "Kanagawa lotus"],
  ["light-plus", "Light+"],
  ["material-theme-lighter", "Material theme lighter"],
  ["min-light", "Min light"],
  ["night-owl-light", "Night owl light"],
  ["one-light", "One light"],
  ["rose-pine-dawn", "Rosé Pine dawn"],
  ["slack-ochin", "Slack Ochin"],
  ["snazzy-light", "Snazzy light"],
  ["solarized-light", "Solarized light"],
  ["vitesse-light", "Vitesse light"],
].map(([id, label]) => ({ id: id!, label: label! }));

export const DIFF_DARK_THEMES: ReadonlyArray<DiffThemeOption> = [
  ["pierre-dark", "Pierre dark"],
  ["pierre-dark-soft", "Pierre dark soft"],
  ["pierre-dark-vibrant", "Pierre dark vibrant"],
  ["pierre-dark-protanopia-deuteranopia", "Pierre dark protanopia/deuteranopia"],
  ["pierre-dark-tritanopia", "Pierre dark tritanopia"],
  ["andromeeda", "Andromeeda"],
  ["aurora-x", "Aurora X"],
  ["ayu-dark", "Ayu dark"],
  ["ayu-mirage", "Ayu mirage"],
  ["catppuccin-frappe", "Catppuccin frappé"],
  ["catppuccin-macchiato", "Catppuccin macchiato"],
  ["catppuccin-mocha", "Catppuccin mocha"],
  ["dark-plus", "Dark+"],
  ["dracula", "Dracula"],
  ["dracula-soft", "Dracula soft"],
  ["everforest-dark", "Everforest dark"],
  ["github-dark", "GitHub dark"],
  ["github-dark-default", "GitHub dark default"],
  ["github-dark-dimmed", "GitHub dark dimmed"],
  ["github-dark-high-contrast", "GitHub dark high contrast"],
  ["gruvbox-dark-hard", "Gruvbox dark hard"],
  ["gruvbox-dark-medium", "Gruvbox dark medium"],
  ["gruvbox-dark-soft", "Gruvbox dark soft"],
  ["horizon", "Horizon"],
  ["houston", "Houston"],
  ["kanagawa-dragon", "Kanagawa dragon"],
  ["kanagawa-wave", "Kanagawa wave"],
  ["laserwave", "Laserwave"],
  ["material-theme", "Material theme"],
  ["material-theme-darker", "Material theme darker"],
  ["material-theme-ocean", "Material theme ocean"],
  ["material-theme-palenight", "Material theme palenight"],
  ["min-dark", "Min dark"],
  ["monokai", "Monokai"],
  ["night-owl", "Night owl"],
  ["nord", "Nord"],
  ["one-dark-pro", "One dark pro"],
  ["plastic", "Plastic"],
  ["poimandres", "Poimandres"],
  ["red", "Red"],
  ["rose-pine", "Rosé Pine"],
  ["rose-pine-moon", "Rosé Pine moon"],
  ["slack-dark", "Slack dark"],
  ["solarized-dark", "Solarized dark"],
  ["synthwave-84", "Synthwave '84"],
  ["tokyo-night", "Tokyo night"],
  ["vesper", "Vesper"],
  ["vitesse-black", "Vitesse black"],
  ["vitesse-dark", "Vitesse dark"],
].map(([id, label]) => ({ id: id!, label: label! }));

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
