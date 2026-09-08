import type { Appearance } from "../domain/contracts";

/**
 * The native window colour for each resolved appearance. It pairs with
 * `--shell` in `src/renderer/src/styles.css`, the colour the app shell paints
 * over the whole window: the native value is what shows before the renderer
 * has painted and in the strip a resize exposes, so a value that drifts from
 * that token reads as a flash of the wrong colour. Change both together.
 */
const shellBackgroundColor = {
  light: "#f2f0ec",
  dark: "#040404",
} as const satisfies Record<"light" | "dark", string>;

/**
 * The window colour for a stored appearance. `systemPrefersDark` comes from
 * Electron's `nativeTheme.shouldUseDarkColors`, the main-process reading of
 * the same OS preference the renderer resolves `"system"` against with
 * `prefers-color-scheme`.
 */
export function windowBackgroundColor(
  appearance: Appearance,
  systemPrefersDark: boolean,
): string {
  if (appearance === "system")
    return systemPrefersDark
      ? shellBackgroundColor.dark
      : shellBackgroundColor.light;
  return shellBackgroundColor[appearance];
}
