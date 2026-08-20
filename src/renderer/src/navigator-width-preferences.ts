import * as v from "valibot";

/**
 * The review navigator (file tree) pane's width, in rem. `@pierre/trees`
 * hardcodes its row label as `MiddleTruncate({ split: "extension" })`, which
 * only protects the file extension from truncation — `x_handler.go` and
 * `x_handler_test.go` render identically once the pane is narrow. That
 * truncation strategy isn't configurable through any public option, so the
 * fix is giving the pane enough room and letting the user pick how much.
 */
export type NavigatorWidthPreferences = {
  readonly width: number;
};

export const MIN_NAVIGATOR_WIDTH_REM = 14;
export const MAX_NAVIGATOR_WIDTH_REM = 34;
export const DEFAULT_NAVIGATOR_WIDTH_REM = 18;

export const DEFAULT_NAVIGATOR_WIDTH_PREFERENCES: NavigatorWidthPreferences =
  {
    width: DEFAULT_NAVIGATOR_WIDTH_REM,
  };

const storageKey = "patchdesk.review-navigator-width.v1";

// A single field, matching diff-theme-preferences.ts's shape: an
// out-of-range or wrong-typed stored width resets to the default rather
// than being trusted or clamped to the nearest bound, exactly like an
// unrecognized theme id resets to the default theme.
const preferencesSchema = v.object({
  width: v.fallback(
    v.pipe(
      v.number(),
      v.minValue(MIN_NAVIGATOR_WIDTH_REM),
      v.maxValue(MAX_NAVIGATOR_WIDTH_REM),
    ),
    DEFAULT_NAVIGATOR_WIDTH_REM,
  ),
});

/**
 * Boundary parser for a persisted navigator width. Called with genuinely
 * unknown input from localStorage (parsed JSON), so there is no earlier
 * boundary to move the parse to.
 */
export function parseNavigatorWidthPreferences(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the navigator width preferences I/O boundary parser, called with genuinely unknown JSON parsed from localStorage; there is no earlier boundary to parse at.
  value: unknown,
): NavigatorWidthPreferences {
  const parsed = v.safeParse(preferencesSchema, value);
  return parsed.success ? parsed.output : DEFAULT_NAVIGATOR_WIDTH_PREFERENCES;
}

export function loadNavigatorWidthPreferences(): NavigatorWidthPreferences {
  if (globalThis.window === undefined)
    return DEFAULT_NAVIGATOR_WIDTH_PREFERENCES;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return DEFAULT_NAVIGATOR_WIDTH_PREFERENCES;
    return parseNavigatorWidthPreferences(JSON.parse(stored));
  } catch {
    return DEFAULT_NAVIGATOR_WIDTH_PREFERENCES;
  }
}

export function saveNavigatorWidthPreferences(width: number): void {
  if (globalThis.window === undefined) return;
  const next = parseNavigatorWidthPreferences({ width });
  window.localStorage.setItem(storageKey, JSON.stringify(next));
}
