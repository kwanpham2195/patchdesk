import * as v from "valibot";

import { guideFileIdSchema, guideGroupIdSchema } from "./guide";
import { guideContextCompletenessSchema } from "./guide-preparation";
import type { InsightArtifactCodec } from "./insight-artifact-index";
import {
  insightArtifactHashSchema,
  insightArtifactIdSchema,
  insightArtifactIndexDescriptorSchema,
  insightArtifactReferenceSchema,
  insightArtifactRunIdSchema,
  insightArtifactTimeSchema,
  insightArtifactUnsignedSchema,
  insightTextRootDescriptorSchema,
} from "./insight-artifact-scalars";

// Closed C2 shapes. Every object is a format-2 wrapper of at most 16 KiB; long text and member lists live behind
// TextRoots and typed indexes, so no root embeds an unbounded array.

const reference = insightArtifactReferenceSchema;
const index = insightArtifactIndexDescriptorSchema;
const text = insightTextRootDescriptorSchema;
const U = insightArtifactUnsignedSchema;

const guideOperationSchema = v.strictObject({
  runId: insightArtifactRunIdSchema,
  generation: U,
  cancelEpoch: U,
  opId: insightArtifactIdSchema,
  kind: v.picklist(["open_group", "add_members", "finish"]),
  payload: text,
  payloadHash: insightArtifactHashSchema,
});

const guideReceiptSchema = v.strictObject({
  operation: reference,
  sequence: U,
  result: text,
});

const guideDispatchIntentSchema = v.strictObject({
  binding: reference,
  generation: U,
  cancelEpoch: U,
  requestOrdinal: U,
  requestBody: text,
  requestHash: insightArtifactHashSchema,
  requestBytes: U,
  createdAt: insightArtifactTimeSchema,
});

const guideRuntimeSchema = v.strictObject({
  preparation: reference,
  phase: v.picklist(["building", "validating", "validated"]),
  receipts: index,
  frozen: v.nullable(v.strictObject({ sequence: U, receipts: index })),
  result: v.nullable(reference),
});

const guideGroupSchema = v.strictObject({
  id: guideGroupIdSchema,
  title: text,
  explanation: text,
  members: index,
});

const guideMemberSchema = v.strictObject({
  fileId: guideFileIdSchema,
  relevance: text,
});

const guideInventoryEntryRecordSchema = v.strictObject({
  fileId: guideFileIdSchema,
  entry: text,
});

const guideValidationSchema = v.strictObject({
  binding: reference,
  preparation: reference,
  generation: U,
  cancelEpoch: U,
  frozenSequence: U,
  receipts: index,
  groups: index,
  inventory: index,
  others: index,
  validator: v.literal("guide-membership-v1"),
});

const guideResultRootSchema = v.strictObject({
  binding: reference,
  preparation: reference,
  frozenSequence: U,
  receipts: index,
  groups: index,
  inventory: index,
  others: index,
  validation: reference,
  contextCompleteness: guideContextCompletenessSchema,
});

const guidePublicationSchema = v.strictObject({
  runId: insightArtifactRunIdSchema,
  generation: U,
  cancelEpoch: U,
  expectedSlotVersion: U,
  expectedSlotDigest: insightArtifactHashSchema,
  frozenSequence: U,
  receipts: index,
  result: reference,
  validation: reference,
  publishedAt: insightArtifactTimeSchema,
});

export const guideOperationCodec: InsightArtifactCodec<
  typeof guideOperationSchema
> = { name: "GuideOperation1", schema: guideOperationSchema };
export const guideReceiptCodec: InsightArtifactCodec<
  typeof guideReceiptSchema
> = { name: "GuideReceipt1", schema: guideReceiptSchema };
export const guideDispatchIntentCodec: InsightArtifactCodec<
  typeof guideDispatchIntentSchema
> = { name: "GuideDispatchIntent1", schema: guideDispatchIntentSchema };
export const guideRuntimeCodec: InsightArtifactCodec<
  typeof guideRuntimeSchema
> = { name: "GuideRuntime1", schema: guideRuntimeSchema };
export const guideGroupCodec: InsightArtifactCodec<typeof guideGroupSchema> = {
  name: "GuideGroup1",
  schema: guideGroupSchema,
};
export const guideMemberCodec: InsightArtifactCodec<typeof guideMemberSchema> =
  { name: "GuideMember1", schema: guideMemberSchema };
export const guideInventoryEntryCodec: InsightArtifactCodec<
  typeof guideInventoryEntryRecordSchema
> = { name: "GuideInventoryEntry1", schema: guideInventoryEntryRecordSchema };
export const guideValidationCodec: InsightArtifactCodec<
  typeof guideValidationSchema
> = { name: "GuideValidation1", schema: guideValidationSchema };
export const guideResultRootCodec: InsightArtifactCodec<
  typeof guideResultRootSchema
> = { name: "GuideResultRoot1", schema: guideResultRootSchema };
export const guidePublicationCodec: InsightArtifactCodec<
  typeof guidePublicationSchema
> = { name: "GuidePublication1", schema: guidePublicationSchema };

export type GuideRuntime = v.InferOutput<typeof guideRuntimeSchema>;
export type GuideGroup = v.InferOutput<typeof guideGroupSchema>;
export type GuideResultRoot = v.InferOutput<typeof guideResultRootSchema>;
