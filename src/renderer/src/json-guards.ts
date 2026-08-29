/**
 * The two generic JSON guards the renderer's own `unknown` boundaries narrow
 * with before any field parsing. They moved here out of `app.tsx` unchanged
 * when that file's hooks were split out: `record` is shared by the profile
 * parser (`workspace-state.ts`) and the global-settings parser
 * (`hooks/use-global-preferences.ts`), so it cannot live inside either.
 */
export function record(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the foundational "is a plain object" boundary predicate every other parser in this file narrows further; there is no earlier, more specific boundary.
  value: unknown,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- generic "is a plain object" predicate; the point is that field shapes are not yet known, so each caller (isProfile, parseGlobalSettings, ...) narrows specific fields itself immediately after.
): value is Record<string, unknown> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external input at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
  return typeof value === "object" && value !== null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the string-array I/O boundary parser reused by isProfile below; there is no earlier boundary to move the parse to.
export function stringArray(value: unknown): value is ReadonlyArray<string> {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external array entries at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}
