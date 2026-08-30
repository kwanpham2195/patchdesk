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
 * Each field owns its generation and failed value. A settlement can therefore
 * affect only the intent that started it, while the shared retry control runs
 * the most recently failed field without replaying obsolete intent.
 */
export type GlobalPreferences = {
  readonly appearance: AppearancePreference;
  readonly diffThemePreferences: DiffThemePreferences;
  readonly preferenceError: string | undefined;
  readonly updateAppearance: (next: AppearancePreference) => Promise<void>;
  readonly updateDiffTheme: (next: DiffThemePreferences) => Promise<void>;
  readonly retryPreferences: () => void;
};

type PreferenceFailure = {
  readonly message: string;
  readonly order: number;
};

type PreferenceRetry = {
  readonly order: number;
  readonly run: () => Promise<void>;
};

export function useGlobalPreferences(fixtureMode: boolean): GlobalPreferences {
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    loadAppearancePreference(),
  );
  const [diffThemePreferences, setDiffThemePreferences] =
    useState<DiffThemePreferences>(() => loadDiffThemePreferences());
  const [loadError, setLoadError] = useState<string>();
  const [appearanceFailure, setAppearanceFailure] =
    useState<PreferenceFailure>();
  const [diffThemeFailure, setDiffThemeFailure] = useState<PreferenceFailure>();
  const appearanceGeneration = useRef(0);
  const diffThemeGeneration = useRef(0);
  const failureOrder = useRef(0);
  const loadRetry = useRef<(() => Promise<void>) | undefined>(undefined);
  const appearanceRetry = useRef<PreferenceRetry | undefined>(undefined);
  const diffThemeRetry = useRef<PreferenceRetry | undefined>(undefined);

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
      const appearanceOwner = appearanceGeneration.current;
      const diffThemeOwner = diffThemeGeneration.current;
      loadRetry.current = loadGlobalPreferences;
      if (active) setLoadError(undefined);
      let stored: GlobalSettings;
      try {
        stored = parseGlobalSettings(await api("/v1/settings"));
      } catch {
        // A missing config file is a genuine first run and is already
        // normalized to an empty settings object upstream, so any rejection
        // here is a real load failure (corrupt file, I/O error, ...).
        if (
          active &&
          loadRetry.current === loadGlobalPreferences &&
          appearanceGeneration.current === appearanceOwner &&
          diffThemeGeneration.current === diffThemeOwner
        )
          setLoadError(
            "Could not load saved preferences. Appearance and diff theme are using defaults; retry to reload the saved settings, or change a preference to overwrite the stored file.",
          );
        return;
      }
      if (!active) return;
      loadRetry.current = undefined;
      const ownsAppearance = appearanceGeneration.current === appearanceOwner;
      const ownsDiffTheme = diffThemeGeneration.current === diffThemeOwner;
      const appearanceFromStorage = stored.appearance;
      const diffThemeFromStorage = stored.diffTheme;
      const migratedAppearance =
        ownsAppearance && appearanceFromStorage === undefined;
      const migratedDiffTheme =
        ownsDiffTheme && diffThemeFromStorage === undefined;
      const nextAppearance =
        appearanceFromStorage ?? loadAppearancePreference();
      const nextDiffTheme =
        diffThemeFromStorage === undefined
          ? loadDiffThemePreferences()
          : parseDiffThemePreferences(diffThemeFromStorage);
      const correctedDiffTheme =
        ownsDiffTheme &&
        diffThemeFromStorage !== undefined &&
        !sameDiffTheme(diffThemeFromStorage, nextDiffTheme);

      if (ownsAppearance && appearanceFromStorage !== undefined)
        setAppearance(nextAppearance);
      if (ownsDiffTheme && diffThemeFromStorage !== undefined)
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
      if (
        migratedAppearance &&
        appearanceGeneration.current === appearanceOwner
      )
        clearAppearancePreference();
      if (migratedDiffTheme && diffThemeGeneration.current === diffThemeOwner)
        clearDiffThemePreferences();
    };
    void loadGlobalPreferences();
    return () => {
      active = false;
    };
  }, [fixtureMode]);

  const updateAppearance = useCallback(
    async (next: AppearancePreference): Promise<void> => {
      const generation = ++appearanceGeneration.current;
      appearanceRetry.current = undefined;
      setAppearance(next);
      setAppearanceFailure(undefined);
      setLoadError(undefined);
      loadRetry.current = undefined;
      try {
        const stored = parseGlobalSettings(
          await api("/v1/settings", {
            method: "PATCH",
            body: { appearance: next },
          }),
        );
        if (appearanceGeneration.current !== generation) return;
        if (stored.appearance !== undefined) setAppearance(stored.appearance);
      } catch {
        if (appearanceGeneration.current !== generation) return;
        const order = ++failureOrder.current;
        const retry: PreferenceRetry = {
          order,
          run: async () => {
            if (appearanceRetry.current !== retry) return;
            await updateAppearance(next);
          },
        };
        appearanceRetry.current = retry;
        setAppearanceFailure({
          order,
          message:
            "Could not save appearance. The visible change is active; retry to persist it.",
        });
      }
    },
    [],
  );
  const updateDiffTheme = useCallback(
    async (next: DiffThemePreferences): Promise<void> => {
      const generation = ++diffThemeGeneration.current;
      diffThemeRetry.current = undefined;
      setDiffThemePreferences(next);
      setDiffThemeFailure(undefined);
      setLoadError(undefined);
      loadRetry.current = undefined;
      try {
        const stored = parseGlobalSettings(
          await api("/v1/settings", {
            method: "PATCH",
            body: { diffTheme: next },
          }),
        );
        if (diffThemeGeneration.current !== generation) return;
        if (stored.diffTheme !== undefined)
          setDiffThemePreferences(parseDiffThemePreferences(stored.diffTheme));
      } catch {
        if (diffThemeGeneration.current !== generation) return;
        const order = ++failureOrder.current;
        const retry: PreferenceRetry = {
          order,
          run: async () => {
            if (diffThemeRetry.current !== retry) return;
            await updateDiffTheme(next);
          },
        };
        diffThemeRetry.current = retry;
        setDiffThemeFailure({
          order,
          message:
            "Could not save diff theme. The visible change is active; retry to persist it.",
        });
      }
    },
    [],
  );
  const retryPreferences = useCallback((): void => {
    const appearanceOwner = appearanceRetry.current;
    const diffThemeOwner = diffThemeRetry.current;
    const owner =
      appearanceOwner === undefined
        ? diffThemeOwner
        : diffThemeOwner === undefined ||
            appearanceOwner.order > diffThemeOwner.order
          ? appearanceOwner
          : diffThemeOwner;
    if (owner !== undefined) {
      void owner.run();
      return;
    }
    void loadRetry.current?.();
  }, []);
  const preferenceFailure =
    appearanceFailure === undefined
      ? diffThemeFailure
      : diffThemeFailure === undefined ||
          appearanceFailure.order > diffThemeFailure.order
        ? appearanceFailure
        : diffThemeFailure;
  return {
    appearance,
    diffThemePreferences,
    preferenceError: preferenceFailure?.message ?? loadError,
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
