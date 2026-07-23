import { registerCustomTheme } from "@pierre/diffs";
import { themes } from "@pierre/theming/themes";

export type PierreThemeOption = {
  readonly id: string;
  readonly label: string;
};

function labelFor(name: string, displayName?: string): string {
  return displayName ?? name.replaceAll("-", " ");
}

function optionsFor(colorScheme: "light" | "dark"): ReadonlyArray<PierreThemeOption> {
  return themes
    .getThemes({ colorScheme })
    .map((theme) => ({ id: theme.name, label: labelFor(theme.name, theme.displayName) }));
}

export const PIERRE_LIGHT_THEMES = optionsFor("light");
export const PIERRE_DARK_THEMES = optionsFor("dark");

let registered = false;

/**
 * @pierre/diffs registers its own Pierre theme collection. Register the
 * bundled Shiki collection exactly once so a saved non-Pierre choice remains
 * lazy-loaded and valid without touching private package paths.
 */
export function registerPierreThemeLoaders(): void {
  if (registered) return;
  registered = true;
  for (const theme of themes.getThemes({ collection: "shiki" })) {
    registerCustomTheme(theme.name, theme.load);
  }
}
