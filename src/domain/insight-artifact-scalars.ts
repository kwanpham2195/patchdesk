import * as v from "valibot";

import { parseGitSha, parseInsightRunId, parseIsoTimestamp } from "./ids";
import { err, ok, type Result } from "./result";

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

/** P: an unsigned integer of at least 1. */
export const insightArtifactPositiveSchema = v.pipe(
  insightArtifactUnsignedSchema,
  v.minValue(1),
);

/** Time: the stored millisecond timestamp format. */
export const insightArtifactTimeSchema = v.pipe(
  v.string(),
  v.check((value) => parseIsoTimestamp(value)._tag === "ok"),
);

/** GitSha: the lowercase SHA syntax Patchdesk accepts. */
export const insightArtifactGitShaSchema = v.pipe(
  v.string(),
  v.check((value) => parseGitSha(value)._tag === "ok"),
);

/** A new run's Id must also be usable as a producer-facing run ID. */
export const insightArtifactRunIdSchema = v.pipe(
  insightArtifactIdSchema,
  v.check((value) => parseInsightRunId(value)._tag === "ok"),
);

/** A run Id that passed the format-2 alphabet and `parseInsightRunId`. */
export type InsightArtifactRunId = v.InferOutput<
  typeof insightArtifactRunIdSchema
>;

/** Lowercase SHA-256, validated before digest-based path resolution. */
export const insightArtifactHashSchema = v.pipe(
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

/** I<X>: the root of an Index<X> object and its entry count; both are checked while traversing. */
export const insightArtifactIndexDescriptorSchema = v.strictObject({
  root: insightArtifactReferenceSchema,
  count: insightArtifactUnsignedSchema,
});

/** Index descriptor shape only. */
export type InsightArtifactIndexDescriptor = v.InferOutput<
  typeof insightArtifactIndexDescriptorSchema
>;

const bytesRootDescriptorSchema = v.strictObject({
  blocks: insightArtifactIndexDescriptorSchema,
  bytes: insightArtifactUnsignedSchema,
  sha256: insightArtifactHashSchema,
});

/** TextRoot descriptor: a fixed record whose bytes live behind its block index. */
export const insightTextRootDescriptorSchema = v.strictObject({
  data: bytesRootDescriptorSchema,
  utf16Units: insightArtifactUnsignedSchema,
});

/** Text descriptor shape only; its blocks and bytes are verified by the storage reader. */
export type InsightTextRootDescriptor = v.InferOutput<
  typeof insightTextRootDescriptorSchema
>;

/** JSON representation accepted only after the owning closed schema has parsed it. */
export type InsightCanonicalValue =
  | null
  | string
  | boolean
  | number
  | ReadonlyArray<InsightCanonicalValue>
  | { readonly [key: string]: InsightCanonicalValue };

/** Decodes UTF-8 bytes through the selected closed schema; exact re-encoding rejects duplicate keys and noncanonical JSON. */
export function parseInsightArtifactCanonicalJson<
  TSchema extends v.GenericSchema<unknown, InsightCanonicalValue>,
>(
  bytes: Uint8Array,
  schema: TSchema,
): Result<v.InferOutput<TSchema>, { readonly _tag: "InvalidInsightArtifact" }> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const input: unknown = JSON.parse(text);
    const parsed = v.safeParse(schema, input);
    if (
      parsed.success &&
      encodeInsightArtifactCanonicalJson(parsed.output) === text
    )
      return ok(parsed.output);
  } catch {
    // Rejected bytes never become absence or permission to heal stored authority.
  }
  return err({ _tag: "InvalidInsightArtifact" });
}

/** Encodes closed-schema values with the same representation used by canonical reads. */
export function encodeInsightArtifactCanonicalJson(
  value: InsightCanonicalValue,
): string | undefined {
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
        const entries = value.map(encodeInsightArtifactCanonicalJson);
        return entries.includes(undefined)
          ? undefined
          : `[${entries.join(",")}]`;
      }
      const entries = Object.entries(value).sort(([left], [right]) =>
        compareCodePoints(left, right),
      );
      const fields: string[] = [];
      for (const [key, child] of entries) {
        const encoded = encodeInsightArtifactCanonicalJson(child);
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
