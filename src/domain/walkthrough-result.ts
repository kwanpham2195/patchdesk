import * as v from "valibot";
import type { InsightArtifactCodec } from "./insight-artifact-index";
import { guideContextCompletenessSchema } from "./guide-preparation";
import {
  insightArtifactReferenceSchema as R,
  insightArtifactIndexDescriptorSchema as I,
  insightTextRootDescriptorSchema as T,
  insightArtifactUnsignedSchema as U,
  insightArtifactPositiveSchema as P,
  insightArtifactRunIdSchema,
  insightArtifactIdSchema,
  insightArtifactHashSchema,
  insightArtifactTimeSchema,
} from "./insight-artifact-scalars";
import {
  walkthroughChapterIdSchema,
  walkthroughSectionIdSchema,
} from "./walkthrough-protocol";
import { walkthroughHunkIdSchema } from "./walkthrough-preparation";

const operation = v.strictObject({
  runId: insightArtifactRunIdSchema,
  generation: U,
  cancelEpoch: U,
  opId: insightArtifactIdSchema,
  kind: v.picklist([
    "begin_walkthrough",
    "open_chapter",
    "open_section",
    "add_citations",
    "finish",
  ]),
  payload: T,
  payloadHash: insightArtifactHashSchema,
});
const receipt = v.strictObject({ operation: R, sequence: P, result: T });
const dispatch = v.strictObject({
  binding: R,
  generation: U,
  cancelEpoch: U,
  requestOrdinal: U,
  requestBody: T,
  requestHash: insightArtifactHashSchema,
  requestBytes: U,
  createdAt: insightArtifactTimeSchema,
});
const runtime = v.strictObject({
  preparation: R,
  phase: v.picklist(["building", "validating", "validated"]),
  receipts: I,
  frozen: v.nullable(v.strictObject({ sequence: P, receipts: I })),
  result: v.nullable(R),
});
const chapter = v.strictObject({
  id: walkthroughChapterIdSchema,
  title: T,
  firstSection: U,
  sectionCount: P,
});
const section = v.strictObject({
  id: walkthroughSectionIdSchema,
  chapterId: walkthroughChapterIdSchema,
  title: T,
  prose: T,
  citations: I,
});
const citation = v.strictObject({ hunkId: walkthroughHunkIdSchema, hunk: R });
const graph = {
  binding: R,
  preparation: R,
  frozenSequence: P,
  receipts: I,
  title: T,
  focus: T,
  chapters: I,
  sections: I,
  hunks: I,
  uncited: I,
  citedHunks: U,
  contextCompleteness: guideContextCompletenessSchema,
};
const validation = v.strictObject({
  ...graph,
  generation: U,
  cancelEpoch: U,
  validator: v.literal("walkthrough-citations-v1"),
});
const root = v.strictObject({ ...graph, validation: R });
const publication = v.strictObject({
  runId: insightArtifactRunIdSchema,
  generation: U,
  cancelEpoch: U,
  expectedSlotVersion: U,
  expectedSlotDigest: insightArtifactHashSchema,
  frozenSequence: P,
  receipts: I,
  result: R,
  validation: R,
  publishedAt: insightArtifactTimeSchema,
});
/** Immutable accepted mutation. */
export const walkthroughOperationCodec: InsightArtifactCodec<typeof operation> =
  { name: "WalkthroughOperation1", schema: operation };
/** Durable sequential receipt. */
export const walkthroughReceiptCodec: InsightArtifactCodec<typeof receipt> = {
  name: "WalkthroughReceipt1",
  schema: receipt,
};
/** Exact recorded paid request. */
export const walkthroughDispatchIntentCodec: InsightArtifactCodec<
  typeof dispatch
> = { name: "WalkthroughDispatchIntent1", schema: dispatch };
/** Specialized journal runtime. */
export const walkthroughRuntimeCodec: InsightArtifactCodec<typeof runtime> = {
  name: "WalkthroughRuntime1",
  schema: runtime,
};
/** Ordered chapter span. */
export const walkthroughChapterCodec: InsightArtifactCodec<typeof chapter> = {
  name: "WalkthroughChapter1",
  schema: chapter,
};
/** One section and its bounded citation index. */
export const walkthroughSectionCodec: InsightArtifactCodec<typeof section> = {
  name: "WalkthroughSection1",
  schema: section,
};
/** Captured hunk reference, never a provider-authored path. */
export const walkthroughCitationCodec: InsightArtifactCodec<typeof citation> = {
  name: "WalkthroughCitation1",
  schema: citation,
};
/** Independently replayed and verified graph. */
export const walkthroughValidationCodec: InsightArtifactCodec<
  typeof validation
> = { name: "WalkthroughValidation1", schema: validation };
/** Published descriptor-only result. */
export const walkthroughResultRootCodec: InsightArtifactCodec<typeof root> = {
  name: "WalkthroughResultRoot1",
  schema: root,
};
/** Pointer publication evidence. */
export const walkthroughPublicationCodec: InsightArtifactCodec<
  typeof publication
> = { name: "WalkthroughPublication1", schema: publication };
