import * as v from "valibot";

import {
  explanationFrameIdentity,
  explanationOperationIdentity,
  explanationRequestOpenSchema,
  explanationRequestChunkSchema,
  explanationRequestCommitSchema,
  explanationHandleSchema,
  explanationStoredSchema,
  explanationPermissionSchema,
} from "./explanation-channel";
import {
  insightArtifactIdSchema,
  insightArtifactPositiveSchema,
  insightArtifactIndexDescriptorSchema,
} from "./insight-artifact-scalars";
import {
  walkthroughHunkIdSchema,
  walkthroughChapterIdSchema,
  walkthroughSectionIdSchema,
} from "./walkthrough-selectors.js";

const concise = (max: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const opId = insightArtifactIdSchema;
/** Strict model-facing inputs, bounded by encoded bytes rather than citation count. */
export const walkthroughInputSchemas = {
  begin_walkthrough: v.strictObject({
    opId,
    title: concise(200),
    focus: concise(320),
  }),
  open_chapter: v.strictObject({ opId, title: concise(80) }),
  open_section: v.strictObject({
    opId,
    chapterId: walkthroughChapterIdSchema,
    title: concise(160),
    prose: concise(320),
  }),
  add_citations: v.strictObject({
    opId,
    sectionId: walkthroughSectionIdSchema,
    hunkIds: v.pipe(v.array(walkthroughHunkIdSchema), v.minLength(1)),
  }),
  finish: v.strictObject({ opId }),
  lookup_receipt: v.strictObject({ opId }),
};
const toolCallSchema = v.variant("tool", [
  v.strictObject({
    tool: v.literal("begin_walkthrough"),
    input: walkthroughInputSchemas.begin_walkthrough,
  }),
  v.strictObject({
    tool: v.literal("open_chapter"),
    input: walkthroughInputSchemas.open_chapter,
  }),
  v.strictObject({
    tool: v.literal("open_section"),
    input: walkthroughInputSchemas.open_section,
  }),
  v.strictObject({
    tool: v.literal("add_citations"),
    input: walkthroughInputSchemas.add_citations,
  }),
  v.strictObject({
    tool: v.literal("finish"),
    input: walkthroughInputSchemas.finish,
  }),
  v.strictObject({
    tool: v.literal("lookup_receipt"),
    input: walkthroughInputSchemas.lookup_receipt,
  }),
]);
/** Shared FD3 envelopes with a closed Walkthrough tool vocabulary. */
export const walkthroughChildFrameSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("tool"),
    ...explanationFrameIdentity,
    call: toolCallSchema,
  }),
  explanationRequestOpenSchema,
  explanationRequestChunkSchema,
  explanationRequestCommitSchema,
]);
/** Canonical payloads include the operation kind and host-owned identity. */
export const walkthroughPayloadSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("begin_walkthrough"),
    ...walkthroughInputSchemas.begin_walkthrough.entries,
    ...explanationOperationIdentity,
  }),
  v.strictObject({
    kind: v.literal("open_chapter"),
    ...walkthroughInputSchemas.open_chapter.entries,
    ...explanationOperationIdentity,
  }),
  v.strictObject({
    kind: v.literal("open_section"),
    ...walkthroughInputSchemas.open_section.entries,
    ...explanationOperationIdentity,
  }),
  v.strictObject({
    kind: v.literal("add_citations"),
    ...walkthroughInputSchemas.add_citations.entries,
    ...explanationOperationIdentity,
  }),
  v.strictObject({
    kind: v.literal("finish"),
    ...walkthroughInputSchemas.finish.entries,
    ...explanationOperationIdentity,
  }),
]);
/** Accepted operation results never embed section text or hunk bodies. */
export const walkthroughReceiptResultSchema = v.union([
  v.strictObject({ started: v.literal(true) }),
  v.strictObject({ chapterId: walkthroughChapterIdSchema }),
  v.strictObject({
    chapterId: walkthroughChapterIdSchema,
    sectionId: walkthroughSectionIdSchema,
  }),
  v.strictObject({
    sectionId: walkthroughSectionIdSchema,
    count: insightArtifactPositiveSchema,
  }),
  v.strictObject({
    sequence: insightArtifactPositiveSchema,
    receipts: insightArtifactIndexDescriptorSchema,
  }),
]);
/** Refusals promise no accepted mutation for the correlation. */
export const WALKTHROUGH_REFUSAL_REASONS = [
  "stale_identity",
  "closed",
  "already_started",
  "not_started",
  "unknown_chapter",
  "unknown_section",
  "unknown_hunk",
  "duplicate_citation",
  "op_conflict",
  "invalid_input",
  "too_large",
  "sensitive",
  "storage",
  "cancelled",
  "unsupported",
] as const;
/** App replies retain Guide's request-staging wire variants unchanged. */
export const walkthroughAppReplySchema = v.strictObject({
  kind: v.literal("reply"),
  ...explanationFrameIdentity,
  outcome: v.variant("status", [
    v.strictObject({
      status: v.literal("receipt"),
      sequence: insightArtifactPositiveSchema,
      result: walkthroughReceiptResultSchema,
    }),
    v.strictObject({ status: v.literal("not_found") }),
    explanationHandleSchema,
    explanationStoredSchema,
    explanationPermissionSchema,
    v.strictObject({
      status: v.literal("refused"),
      reason: v.picklist(WALKTHROUGH_REFUSAL_REASONS),
    }),
    v.strictObject({ status: v.literal("unknown") }),
  ]),
});
/** Host-selected Walkthrough frame. */
export type WalkthroughChildFrame = v.InferOutput<
  typeof walkthroughChildFrameSchema
>;
/** Model tool request without transport identity. */
export type WalkthroughToolCall = v.InferOutput<typeof toolCallSchema>;
/** Identity-bound mutation payload. */
export type WalkthroughPayload = v.InferOutput<typeof walkthroughPayloadSchema>;
/** Accepted result inside a receipt. */
export type WalkthroughReceiptResult = v.InferOutput<
  typeof walkthroughReceiptResultSchema
>;
/** Receipt, refusal, staging permission or uncertain outcome. */
export type WalkthroughAppOutcome = v.InferOutput<
  typeof walkthroughAppReplySchema
>["outcome"];
/** Closed refusal vocabulary. */
export type WalkthroughRefusalReason =
  (typeof WALKTHROUGH_REFUSAL_REASONS)[number];
