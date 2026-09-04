import { useEffect, useState } from "react";

import type { ResolvedAppearance } from "../appearance-preferences";
import {
  loadDiffThemePreferences,
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "../diff-theme-preferences";

/**
 * The Shiki theme name a code surface outside the Diff tab should use.
 *
 * The Diff tab hands `@pierre/diffs` both halves of the theme pair and lets
 * the element pick with `light-dark()`. A plain highlighted block has no such
 * element, so it resolves the pair itself and follows the same two events the
 * Diff tab listens to, keeping one shared theme choice across both.
 */
export function useDiffCodeTheme(): string {
  const [appearance, setAppearance] = useState<ResolvedAppearance>(() =>
    globalThis.document?.documentElement.dataset.appearance === "light"
      ? "light"
      : "dark",
  );
  const [preferences, setPreferences] = useState<DiffThemePreferences>(() =>
    loadDiffThemePreferences(),
  );

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
      setPreferences(
        parseDiffThemePreferences((event as CustomEvent<unknown>).detail),
      );
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);
    return () => window.removeEventListener("patchdesk:diff-theme", onTheme);
  }, []);

  return appearance === "light" ? preferences.light : preferences.dark;
}
