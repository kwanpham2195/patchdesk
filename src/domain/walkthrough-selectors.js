import * as v from "valibot";

// Native-Node MCP documentation generation loads these schemas without a TypeScript resolver.
const maxSafeDecimal = "9007199254740991";
const safeDecimal = [
  "[1-9]\\d{0,14}",
  ...Array.from(maxSafeDecimal, (digit, index) => {
    const minimum = index === 0 ? 1 : 0;
    const upper = Number(digit) - 1;
    return upper < minimum
      ? null
      : `${maxSafeDecimal.slice(0, index)}[${minimum}-${upper}]\\d{${15 - index}}`;
  }).filter((part) => part !== null),
  maxSafeDecimal,
].join("|");

/** @param {string} prefix */
function ordinalSchema(prefix) {
  // The decimal bound stays in JSON Schema too, which cannot project a numeric v.check on a string.
  return v.pipe(
    v.string(),
    v.maxLength(17),
    v.regex(new RegExp(`^${prefix}(?:${safeDecimal})$`)),
  );
}
/** App-assigned chapter identity in reading order. */
export const walkthroughChapterIdSchema = ordinalSchema("c");
/** App-assigned section identity in global reading order. */
export const walkthroughSectionIdSchema = ordinalSchema("s");
/** Canonical producer alias in the prepared hunk namespace. */
export const walkthroughHunkIdSchema = v.pipe(
  v.string(),
  v.maxLength(16),
  v.regex(/^h[1-9]\d*$/),
);
const cursor = v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(512)));
/** Digest-bound read selector shared by HTTP and MCP. */
export const walkthroughPageSelectorSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("navigation"), cursor }),
  v.strictObject({
    kind: v.literal("section"),
    sectionId: walkthroughSectionIdSchema,
  }),
  v.strictObject({
    kind: v.literal("citations"),
    sectionId: walkthroughSectionIdSchema,
    cursor,
  }),
  v.strictObject({ kind: v.literal("uncited"), cursor }),
  v.strictObject({
    kind: v.literal("hunk_text"),
    sectionId: v.nullable(walkthroughSectionIdSchema),
    hunkId: walkthroughHunkIdSchema,
    field: v.picklist(["raw", "filePrefix", "header", "path"]),
    cursor,
  }),
]);
