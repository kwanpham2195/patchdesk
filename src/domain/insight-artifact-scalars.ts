import * as v from "valibot";

/** The format-2 identifier alphabet is narrower than legacy domain IDs. */
export const insightArtifactIdSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/),
  v.brand("InsightArtifactId"),
);

/** Exact nonnegative safe integers; negative zero is not canonical. */
export const insightArtifactUnsignedSchema = v.pipe(
  v.number(),
  v.check(
    (value) =>
      Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
  ),
);

/** Lowercase SHA-256, validated before digest-based path resolution. */
const insightArtifactHashSchema = v.pipe(
  v.string(),
  v.length(64),
  v.regex(/^[a-f0-9]{64}$/),
  v.brand("InsightArtifactHash"),
);

/** A descriptor does not prove the referenced object's bytes or target schema. */
export const insightArtifactReferenceSchema = v.strictObject({
  hash: insightArtifactHashSchema,
  bytes: insightArtifactUnsignedSchema,
});

/** Reference length includes the complete format-2 wrapper. */
export type InsightArtifactReference = v.InferOutput<
  typeof insightArtifactReferenceSchema
>;

/** HInteger1 preserves binary64 integers beyond the safe-integer range. */
export const insightArtifactInteger1Schema = v.strictObject({
  binary64: v.pipe(
    v.string(),
    v.length(16),
    v.regex(/^[a-f0-9]{16}$/),
    v.check((hex) => {
      const bytes = new Uint8Array(8);
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      const value = new DataView(bytes.buffer).getFloat64(0, false);
      return Number.isFinite(value) && Number.isInteger(value) && value >= 1;
    }),
  ),
});

/** JSON representation accepted only after the owning closed schema has parsed it. */
export type InsightCanonicalValue =
  | null
  | string
  | boolean
  | number
  | ReadonlyArray<InsightCanonicalValue>
  | { readonly [key: string]: InsightCanonicalValue };

/** Compares canonical JSON after closed-schema parsing, so duplicate keys cannot survive re-encoding. */
export function insightArtifactJsonIsCanonical(
  text: string,
  value: InsightCanonicalValue,
): boolean {
  return canonicalJson(value) === text;
}

function canonicalJson(value: InsightCanonicalValue): string | undefined {
  if (value === null) return "null";
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- canonical encoding distinguishes JSON scalar representations, not application records.
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0)
        ? JSON.stringify(value)
        : undefined;
    case "object": {
      if (Array.isArray(value)) {
        const entries = value.map(canonicalJson);
        return entries.includes(undefined)
          ? undefined
          : `[${entries.join(",")}]`;
      }
      const entries = Object.entries(value).sort(([left], [right]) =>
        compareCodePoints(left, right),
      );
      const fields: string[] = [];
      for (const [key, child] of entries) {
        const encoded = canonicalJson(child);
        if (encoded === undefined) return undefined;
        fields.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${fields.join(",")}}`;
    }
    default:
      return undefined;
  }
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(
    left,
    (character) => character.codePointAt(0) ?? -1,
  );
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0) ?? -1,
  );
  for (
    let index = 0;
    index < Math.min(leftPoints.length, rightPoints.length);
    index += 1
  ) {
    const difference = (leftPoints[index] ?? -1) - (rightPoints[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
