import { useEffect, useState } from "react";

import type { ResolvedAppearance } from "../appearance-preferences";
import {
  loadDiffThemePreferences,
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "../diff-theme-preferences";

type DiffAppearanceTheme = {
  readonly appearance: ResolvedAppearance;
  readonly themePreferences: DiffThemePreferences;
};

/** The app appearance and diff theme pair, following their change events. */
export function useDiffAppearanceTheme(): DiffAppearanceTheme {
  const [appearance, setAppearance] = useState<ResolvedAppearance>(() =>
    globalThis.document?.documentElement.dataset.appearance === "light"
      ? "light"
      : "dark",
  );
  const [themePreferences, setThemePreferences] =
    useState<DiffThemePreferences>(() => loadDiffThemePreferences());

  useEffect(() => {
    const onAppearance = (event: Event): void => {
      // SAFETY: only `applyAppearance`'s CustomEvent fires this listener; the
      // check below still validates the detail before trusting it.
      const value = (event as CustomEvent<ResolvedAppearance>).detail;
      if (value === "light" || value === "dark") setAppearance(value);
    };
    window.addEventListener("patchdesk:appearance", onAppearance);
    return () =>
      window.removeEventListener("patchdesk:appearance", onAppearance);
  }, []);

  useEffect(() => {
    const onTheme = (event: Event): void => {
      // SAFETY: only a `patchdesk:diff-theme` CustomEvent reaches this
      // listener, and `parseDiffThemePreferences` validates its detail.
      setThemePreferences(
        parseDiffThemePreferences((event as CustomEvent<unknown>).detail),
      );
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);
    return () => window.removeEventListener("patchdesk:diff-theme", onTheme);
  }, []);

  return { appearance, themePreferences };
}

/**
 * The Shiki theme name a code surface outside the Diff tab should use.
 *
 * The Diff tab hands `@pierre/diffs` both halves of the theme pair and lets
 * the element pick with `light-dark()`; a plain highlighted block resolves the
 * pair itself.
 */
export function useDiffCodeTheme(): string {
  const { appearance, themePreferences } = useDiffAppearanceTheme();
  return appearance === "light"
    ? themePreferences.light
    : themePreferences.dark;
}
