import * as v from "valibot";

import { definePreference } from "./lib/local-preference";
import {
  PIERRE_DARK_THEMES,
  PIERRE_LIGHT_THEMES,
} from "./pierre-theme-catalog.generated";

export const DIFF_LIGHT_THEMES = PIERRE_LIGHT_THEMES;
export const DIFF_DARK_THEMES = PIERRE_DARK_THEMES;

export type DiffThemePreferences = {
  readonly light: string;
  readonly dark: string;
};

// `as const satisfies` (rather than `: DiffThemePreferences`) keeps `light`/
// `dark` as literal types so they can be passed directly as `v.fallback`
// defaults below, which must match the picklist's literal option type.
const DEFAULT_DIFF_THEME_PREFERENCES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const satisfies DiffThemePreferences;

// Every field falls back independently to today's default, matching the old
// `hasTheme` narrowing: an unrecognized or wrong-typed theme id resets only
// that one field, never the whole pair.
const diffThemePreferencesSchema = v.object({
  light: v.fallback(
    v.picklist(DIFF_LIGHT_THEMES.map((theme) => theme.id)),
    DEFAULT_DIFF_THEME_PREFERENCES.light,
  ),
  dark: v.fallback(
    v.picklist(DIFF_DARK_THEMES.map((theme) => theme.id)),
    DEFAULT_DIFF_THEME_PREFERENCES.dark,
  ),
});

// The v1 format stored either the bare family literal directly, or an
// object carrying it under `family`. Both shapes resolve to the same
// `"github" | "high_contrast" | undefined` family before mapping to a pair,
// so a value that isn't either shape (or omits `family`) falls through to
// `undefined` just like the pair fields above fall through to their default.
const v1FamilySchema = v.picklist(["github", "high_contrast"]);
const v1PreferencesSchema = v.pipe(
  v.union([
    v1FamilySchema,
    v.pipe(
      v.object({ family: v.optional(v1FamilySchema) }),
      v.transform((value) => value.family),
    ),
  ]),
  v.transform((family): DiffThemePreferences | undefined => {
    if (family === "github")
      return { light: "pierre-light", dark: "pierre-dark" };
    if (family === "high_contrast") {
      return {
        light: "github-light-high-contrast",
        dark: "github-dark-high-contrast",
      };
    }
    return undefined;
  }),
);

// config.json (over IPC) is the durable store; nothing writes either key any
// more. Both fall back to `undefined` so `loadDiffThemePreferences` can try
// the v2 key, then the v1 key, then the default, in that order.
const diffThemePreference = definePreference({
  key: "patchdesk.diff-theme.v2",
  schema: diffThemePreferencesSchema,
  defaultValue: undefined,
});

const v1DiffThemePreference = definePreference({
  key: "patchdesk.diff-theme.v1",
  schema: v1PreferencesSchema,
  defaultValue: undefined,
});

/**
 * Boundary parser for a persisted or IPC-carried diff theme pair. This is
 * genuinely unknown input from three separate call sites outside this module
 * (a JSON config value, and a `CustomEvent<unknown>` detail), so there is no
 * earlier boundary to move the parse to.
 */
export function parseDiffThemePreferences(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the diff theme preferences I/O boundary parser, called with genuinely unknown values from app.tsx (parsed settings JSON) and review-diff-view.tsx (a CustomEvent detail); there is no earlier boundary to parse at.
  value: unknown,
): DiffThemePreferences {
  return diffThemePreference.parse(value) ?? DEFAULT_DIFF_THEME_PREFERENCES;
}

// app.tsx dispatches applyDiffThemePreferences() on mount and on every
// change, so this cache is always current before any lazily-mounted diff view
// reads it — the seed must not depend on a storage key that nothing writes.
let lastAppliedPreferences: DiffThemePreferences | undefined;

export function loadDiffThemePreferences(): DiffThemePreferences {
  // The v2 key migrates the retired {pierre-light, pierre-dark} default pair
  // to the GitHub defaults, so profiles that persisted the previous default
  // adopt the improvement without clearing storage; explicit custom pairs are
  // returned unchanged.
  return (
    lastAppliedPreferences ??
    diffThemePreference.load() ??
    v1DiffThemePreference.load() ??
    DEFAULT_DIFF_THEME_PREFERENCES
  );
}

/**
 * Removes renderer preference keys after config.json accepts the durable
 * value. Does not clear the in-memory `lastAppliedPreferences` cache: that
 * cache is the live source of truth for already-mounted and future diff
 * views, independent of the now-legacy localStorage keys.
 */
export function clearDiffThemePreferences(): void {
  diffThemePreference.clear();
  v1DiffThemePreference.clear();
}

/** Announces an already-persisted preference change to mounted diff views. */
export function applyDiffThemePreferences(value: DiffThemePreferences): void {
  lastAppliedPreferences = value;
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
