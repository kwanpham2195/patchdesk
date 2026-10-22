import * as v from "valibot";

import { guideFileIdSchema } from "./guide";
import { guidePreparedInputCodec } from "./guide-preparation";
import type { InsightArtifactCodec } from "./insight-artifact-index";
import {
  insightArtifactIndexDescriptorSchema,
  insightArtifactUnsignedSchema,
  insightTextRootDescriptorSchema,
} from "./insight-artifact-scalars";

import { walkthroughHunkIdSchema } from "./walkthrough-selectors.js";

const text = insightTextRootDescriptorSchema;
const U = insightArtifactUnsignedSchema;
const walkthroughHunkSchema = v.strictObject({
  id: walkthroughHunkIdSchema,
  fileId: guideFileIdSchema,
  path: text,
  header: text,
  filePrefix: text,
  raw: text,
  oldStart: U,
  oldLines: U,
  newStart: U,
  newLines: U,
});

const walkthroughPreparedInputSchema = v.strictObject({
  ...guidePreparedInputCodec.schema.entries,
  hunks: insightArtifactIndexDescriptorSchema,
});

/** Stored source hunks have bounded wrappers; their text remains in TextRoots. */
export const walkthroughHunkCodec: InsightArtifactCodec<
  typeof walkthroughHunkSchema
> = { name: "WalkthroughHunk1", schema: walkthroughHunkSchema };

/** Walkthrough preparation names the complete captured evidence and exact hunk index. */
export const walkthroughPreparedInputCodec: InsightArtifactCodec<
  typeof walkthroughPreparedInputSchema
> = {
  name: "WalkthroughPreparedInput1",
  schema: walkthroughPreparedInputSchema,
};

/** Complete prepared Walkthrough dependencies. */
export type WalkthroughPreparedInput = v.InferOutput<
  typeof walkthroughPreparedInputSchema
>;
