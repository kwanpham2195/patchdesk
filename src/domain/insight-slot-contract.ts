import * as v from "valibot";

import { parseInsightRunId, parseIsoTimestamp } from "./ids";
import {
  insightArtifactIdSchema,
  insightArtifactInteger1Schema,
  insightArtifactJsonIsCanonical,
  insightArtifactReferenceSchema,
  insightArtifactUnsignedSchema,
  type InsightCanonicalValue,
} from "./insight-artifact-scalars";
import { err, ok, type Result } from "./result";

const slotPointerSchema = v.strictObject({
  format: v.literal(2),
  slotId: insightArtifactIdSchema,
  version: insightArtifactUnsignedSchema,
  record: insightArtifactReferenceSchema,
});

const activeRunRefSchema = v.variant("tag", [
  v.strictObject({
    tag: v.literal("current"),
    runId: v.pipe(
      insightArtifactIdSchema,
      v.check((value) => parseInsightRunId(value)._tag === "ok"),
    ),
    journalId: insightArtifactIdSchema,
  }),
  v.strictObject({
    tag: v.literal("legacy"),
    run: insightArtifactReferenceSchema,
  }),
]);

const retainedRefSchema = v.variant("tag", [
  v.strictObject({
    tag: v.literal("generated"),
    root: insightArtifactReferenceSchema,
  }),
  v.strictObject({
    tag: v.literal("historical"),
    root: insightArtifactReferenceSchema,
  }),
]);

const slotRecord3Schema = v.strictObject({
  schemaVersion: v.literal(3),
  slotId: insightArtifactIdSchema,
  identity: insightArtifactReferenceSchema,
  type: v.picklist(["analysis", "walkthrough", "brief", "guide"]),
  version: insightArtifactUnsignedSchema,
  nextToken: insightArtifactInteger1Schema,
  retained: v.nullable(retainedRefSchema),
  actions: v.nullable(insightArtifactReferenceSchema),
  activeRun: v.nullable(activeRunRefSchema),
  replacementFailure: v.nullable(insightArtifactReferenceSchema),
  migration: v.nullable(insightArtifactReferenceSchema),
  publication: v.nullable(insightArtifactReferenceSchema),
  updatedAt: v.pipe(
    v.string(),
    v.check((value) => parseIsoTimestamp(value)._tag === "ok"),
  ),
});

const wrappedSlotRecord3Schema = v.strictObject({
  format: v.literal(2),
  schema: v.literal("SlotRecord3"),
  value: slotRecord3Schema,
});

/** Direct canonical pointer, not a wrapped immutable object. */
type InsightSlotPointer = v.InferOutput<typeof slotPointerSchema>;

/** Parsed slot metadata only; referenced graphs and publication authority remain unvalidated. */
export type InsightSlotRecord3 = v.InferOutput<typeof slotRecord3Schema>;

/** Current bytes failed UTF-8, JSON, canonical representation or the selected closed schema. */
type InvalidInsightSlot = { readonly _tag: "InvalidInsightSlot" };

/** Reads only the direct format-2 pointer representation, without legacy fallback. */
export function parseInsightSlotPointer(
  bytes: Uint8Array,
): Result<InsightSlotPointer, InvalidInsightSlot> {
  return parseCanonicalSlot(bytes, slotPointerSchema);
}

/** The wrapper participates in byte/hash validation at the storage boundary. */
export function parseWrappedInsightSlotRecord3(
  bytes: Uint8Array,
): Result<InsightSlotRecord3, InvalidInsightSlot> {
  const parsed = parseCanonicalSlot(bytes, wrappedSlotRecord3Schema);
  return parsed._tag === "err" ? parsed : ok(parsed.value.value);
}

function parseCanonicalSlot<
  TSchema extends v.GenericSchema<unknown, InsightCanonicalValue>,
>(
  bytes: Uint8Array,
  schema: TSchema,
): Result<v.InferOutput<TSchema>, InvalidInsightSlot> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const input: unknown = JSON.parse(text);
    const parsed = v.safeParse(schema, input);
    if (parsed.success && insightArtifactJsonIsCanonical(text, parsed.output))
      return ok(parsed.output);
  } catch {
    // Rejected bytes never become an absent slot or permission to heal it.
  }
  return err({ _tag: "InvalidInsightSlot" });
}
