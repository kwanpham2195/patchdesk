import * as v from "valibot";

import {
  encodeInsightArtifactDirect,
  type InsightArtifactCodec,
} from "./insight-artifact-index";
import {
  insightArtifactIdSchema,
  insightArtifactPositiveSchema,
  insightArtifactReferenceSchema,
  insightArtifactRunIdSchema,
  insightArtifactTimeSchema,
  insightArtifactUnsignedSchema,
  parseInsightArtifactCanonicalJson,
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
    runId: insightArtifactRunIdSchema,
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
  nextToken: insightArtifactPositiveSchema,
  retained: v.nullable(retainedRefSchema),
  actions: v.nullable(insightArtifactReferenceSchema),
  activeRun: v.nullable(activeRunRefSchema),
  replacementFailure: v.nullable(insightArtifactReferenceSchema),
  migration: v.nullable(insightArtifactReferenceSchema),
  publication: v.nullable(insightArtifactReferenceSchema),
  updatedAt: insightArtifactTimeSchema,
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
  const parsed = parseInsightArtifactCanonicalJson(bytes, slotPointerSchema);
  return parsed._tag === "err" ? err({ _tag: "InvalidInsightSlot" }) : parsed;
}

export function encodeInsightSlotPointer(
  value: InsightSlotPointer,
): Result<Uint8Array, InvalidInsightSlot> {
  const encoded = encodeInsightArtifactDirect(slotPointerSchema, value);
  return encoded._tag === "ok" ? encoded : err({ _tag: "InvalidInsightSlot" });
}

/** The wrapper participates in byte/hash validation at the storage boundary. */
export function parseWrappedInsightSlotRecord3(
  bytes: Uint8Array,
): Result<InsightSlotRecord3, InvalidInsightSlot> {
  const parsed = parseInsightArtifactCanonicalJson(
    bytes,
    wrappedSlotRecord3Schema,
  );
  return parsed._tag === "err"
    ? err({ _tag: "InvalidInsightSlot" })
    : ok(parsed.value.value);
}

/** The only registered SlotRecord3 wrapper; writers encode through `encodeWrappedInsightArtifact`. */
export const insightSlotRecord3Codec: InsightArtifactCodec<
  typeof slotRecord3Schema
> = { name: "SlotRecord3", schema: slotRecord3Schema };
