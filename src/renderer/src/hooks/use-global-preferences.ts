import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api-client";
import {
  applyAppearance,
  clearAppearancePreference,
  loadAppearancePreference,
  type AppearancePreference,
} from "../appearance-preferences";
import {
  applyDiffThemePreferences,
  clearDiffThemePreferences,
  loadDiffThemePreferences,
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "../diff-theme-preferences";
import { record } from "../json-guards";

/**
 * Appearance and diff theme: the two preferences stored globally rather than
 * per profile. Both are applied to the document as soon as they change, saved
 * through `PATCH /v1/settings`, and migrated out of local storage on first
 * load.
 *
 * `preferenceError` is the one piece of copy the screen shows for a failed
 * load or save; `retryPreferences` re-runs whichever of the two failed last.
 */
export type GlobalPreferences = {
  readonly appearance: AppearancePreference;
  readonly diffThemePreferences: DiffThemePreferences;
  readonly preferenceError: string | undefined;
  readonly updateAppearance: (next: AppearancePreference) => Promise<void>;
  readonly updateDiffTheme: (next: DiffThemePreferences) => Promise<void>;
  readonly retryPreferences: () => void;
};

export function useGlobalPreferences(fixtureMode: boolean): GlobalPreferences {
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    loadAppearancePreference(),
  );
  const [diffThemePreferences, setDiffThemePreferences] =
    useState<DiffThemePreferences>(() => loadDiffThemePreferences());
  const [preferenceError, setPreferenceError] = useState<string>();
  const preferenceRetry = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    const apply = (): void => {
      applyAppearance(appearance);
    };
    apply();
    if (window.matchMedia === undefined) return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  useEffect(() => {
    applyDiffThemePreferences(diffThemePreferences);
  }, [diffThemePreferences]);
  useEffect(() => {
    if (fixtureMode || window.patchdesk?.request === undefined) return;
    let active = true;
    const loadGlobalPreferences = async (): Promise<void> => {
      preferenceRetry.current = loadGlobalPreferences;
      if (active) setPreferenceError(undefined);
      let stored: GlobalSettings;
      try {
        stored = parseGlobalSettings(await api("/v1/settings"));
      } catch {
        // A missing config file is a genuine first run and is already
        // normalized to an empty settings object upstream, so any rejection
        // here is a real load failure (corrupt file, I/O error, ...).
        if (active)
          setPreferenceError(
            "Could not load saved preferences. Appearance and diff theme are using defaults; retry to reload the saved settings, or change a preference to overwrite the stored file.",
          );
        return;
      }
      const appearanceFromStorage = stored.appearance;
      const diffThemeFromStorage = stored.diffTheme;
      const migratedAppearance = appearanceFromStorage === undefined;
      const migratedDiffTheme = diffThemeFromStorage === undefined;
      const nextAppearance =
        appearanceFromStorage ?? loadAppearancePreference();
      const nextDiffTheme =
        diffThemeFromStorage === undefined
          ? loadDiffThemePreferences()
          : parseDiffThemePreferences(diffThemeFromStorage);
      const correctedDiffTheme =
        diffThemeFromStorage !== undefined &&
        !sameDiffTheme(diffThemeFromStorage, nextDiffTheme);

      if (!active) return;
      if (appearanceFromStorage !== undefined) setAppearance(nextAppearance);
      if (diffThemeFromStorage !== undefined)
        setDiffThemePreferences(nextDiffTheme);

      if (!migratedAppearance && !migratedDiffTheme && !correctedDiffTheme)
        return;
      const appearanceField = migratedAppearance
        ? { appearance: nextAppearance }
        : {};
      const diffThemeField =
        migratedDiffTheme || correctedDiffTheme
          ? { diffTheme: nextDiffTheme }
          : {};
      const patch: GlobalSettingsPatch = {
        ...appearanceField,
        ...diffThemeField,
      };
      try {
        await api("/v1/settings", { method: "PATCH", body: patch });
      } catch {
        return;
      }
      if (!active) return;
      if (migratedAppearance) clearAppearancePreference();
      if (migratedDiffTheme) clearDiffThemePreferences();
    };
    void loadGlobalPreferences();
    return () => {
      active = false;
    };
  }, [fixtureMode]);

  const updateAppearance = useCallback(
    async (next: AppearancePreference): Promise<void> => {
      preferenceRetry.current = async () => updateAppearance(next);
      setAppearance(next);
      setPreferenceError(undefined);
      try {
        const stored = parseGlobalSettings(
          await api("/v1/settings", {
            method: "PATCH",
            body: { appearance: next },
          }),
        );
        if (stored.appearance !== undefined) setAppearance(stored.appearance);
      } catch {
        setPreferenceError(
          "Could not save appearance. The visible change is active; retry to persist it.",
        );
      }
    },
    [],
  );
  const updateDiffTheme = useCallback(
    async (next: DiffThemePreferences): Promise<void> => {
      preferenceRetry.current = async () => updateDiffTheme(next);
      setDiffThemePreferences(next);
      setPreferenceError(undefined);
      try {
        const stored = parseGlobalSettings(
          await api("/v1/settings", {
            method: "PATCH",
            body: { diffTheme: next },
          }),
        );
        if (stored.diffTheme !== undefined)
          setDiffThemePreferences(parseDiffThemePreferences(stored.diffTheme));
      } catch {
        setPreferenceError(
          "Could not save diff theme. The visible change is active; retry to persist it.",
        );
      }
    },
    [],
  );
  const retryPreferences = useCallback((): void => {
    void preferenceRetry.current?.();
  }, []);
  return {
    appearance,
    diffThemePreferences,
    preferenceError,
    updateAppearance,
    updateDiffTheme,
    retryPreferences,
  };
}

type GlobalSettings = {
  readonly appearance?: AppearancePreference;
  readonly diffTheme?: unknown;
};

type GlobalSettingsPatch = {
  readonly appearance?: AppearancePreference;
  readonly diffTheme?: DiffThemePreferences;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the GlobalSettings I/O boundary parser for the raw /v1/settings response; there is no earlier boundary to move the parse to.
function parseGlobalSettings(value: unknown): GlobalSettings {
  if (!record(value)) return {};
  const appearance: AppearancePreference | undefined =
    value.appearance === "system" ||
    value.appearance === "light" ||
    value.appearance === "dark"
      ? value.appearance
      : undefined;
  const appearanceField = appearance === undefined ? {} : { appearance };
  const diffThemeField = Object.hasOwn(value, "diffTheme")
    ? { diffTheme: value.diffTheme }
    : {};
  return { ...appearanceField, ...diffThemeField };
}

function sameDiffTheme(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- compares a raw stored diffTheme value (parsed no further than `record()`) against an already-parsed DiffThemePreferences; there is no earlier boundary for the raw side.
  value: unknown,
  expected: DiffThemePreferences,
): boolean {
  return (
    record(value) &&
    value.light === expected.light &&
    value.dark === expected.dark
  );
}
