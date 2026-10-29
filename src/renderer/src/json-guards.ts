/** Plain-object guard shared by the renderer's `unknown` boundary parsers. */
export function record(
  value: unknown,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- generic "is a plain object" predicate; the point is that field shapes are not yet known, so each caller (parseGlobalSettings, ...) narrows specific fields itself immediately after.
): value is Record<string, unknown> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external input at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
  return typeof value === "object" && value !== null;
}
