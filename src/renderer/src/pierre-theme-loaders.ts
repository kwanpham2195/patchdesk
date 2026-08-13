import { registerCustomTheme } from "@pierre/diffs";
import { themes } from "@pierre/theming/themes";

let registered = false;

/** Registers bundled Shiki theme loaders once inside the lazy Review graph. */
export function registerPierreThemeLoaders(): void {
  if (registered) return;
  registered = true;
  for (const theme of themes.getThemes({ collection: "shiki" })) {
    registerCustomTheme(theme.name, theme.load);
  }
}
