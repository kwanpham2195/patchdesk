import * as v from "valibot";

import { guideFileIdSchema } from "./guide";
import { guidePreparedInputCodec } from "./guide-preparation";
import type { InsightArtifactCodec } from "./insight-artifact-index";
import {
  insightArtifactIndexDescriptorSchema,
  insightArtifactUnsignedSchema,
  insightTextRootDescriptorSchema,
} from "./insight-artifact-scalars";

/** Canonical producer alias, constrained to the prepared hunk namespace. */
const walkthroughHunkIdSchema = v.pipe(
  v.string(),
  v.maxLength(16),
  v.regex(/^h[1-9]\d*$/),
  v.check((id) => Number.isSafeInteger(Number(id.slice(1)))),
);

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
