import * as v from "valibot";

import {
  insightArtifactPositiveSchema,
  insightArtifactRunIdSchema,
  insightArtifactUnsignedSchema,
} from "./insight-artifact-scalars";

export const explanationOperationIdentity = {
  runId: insightArtifactRunIdSchema,
  generation: insightArtifactUnsignedSchema,
  cancelEpoch: insightArtifactUnsignedSchema,
};
export const explanationFrameIdentity = {
  ...explanationOperationIdentity,
  connection: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,64}$/)),
  correlation: insightArtifactPositiveSchema,
};
type ExplanationFrameIdentity = v.InferOutput<
  v.StrictObjectSchema<typeof explanationFrameIdentity, undefined>
>;
export type ExplanationConnectionIdentity = Readonly<
  Omit<ExplanationFrameIdentity, "correlation">
>;
