import * as v from "valibot";

import {
  insightArtifactHashSchema,
  insightArtifactPositiveSchema,
  insightArtifactRunIdSchema,
  insightArtifactUnsignedSchema,
} from "./insight-artifact-scalars";
import { err, ok, type Result } from "./result";

/** The bound includes frame identity and JSON escaping in both directions. */
export const EXPLANATION_MAX_FRAME_BYTES = 32 * 1024;
export const EXPLANATION_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** Base64 plus frame identity must fit the frame bound. */
export const EXPLANATION_REQUEST_CHUNK_BYTES = 12 * 1024;

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
export type ExplanationFrameIdentity = v.InferOutput<
  v.StrictObjectSchema<typeof explanationFrameIdentity, undefined>
>;
export type ExplanationConnectionIdentity = Readonly<
  Omit<ExplanationFrameIdentity, "correlation">
>;
export type ExplanationFrame = ExplanationFrameIdentity & {
  readonly kind: string;
};

export const explanationRequestOpenSchema = v.strictObject({
  kind: v.literal("request_open"),
  ...explanationFrameIdentity,
  totalBytes: v.pipe(
    insightArtifactPositiveSchema,
    v.maxValue(EXPLANATION_MAX_REQUEST_BYTES),
  ),
});
export const explanationRequestChunkSchema = v.strictObject({
  kind: v.literal("request_chunk"),
  ...explanationFrameIdentity,
  handle: insightArtifactPositiveSchema,
  offset: insightArtifactUnsignedSchema,
  data: v.pipe(
    v.string(),
    v.regex(/^[A-Za-z0-9+/]*={0,2}$/),
    v.maxLength(Math.ceil(EXPLANATION_REQUEST_CHUNK_BYTES / 3) * 4),
  ),
});
export const explanationRequestCommitSchema = v.strictObject({
  kind: v.literal("request_commit"),
  ...explanationFrameIdentity,
  handle: insightArtifactPositiveSchema,
  sha256: insightArtifactHashSchema,
  bytes: insightArtifactPositiveSchema,
});

export const explanationHandleSchema = v.strictObject({
  status: v.literal("handle"),
  handle: insightArtifactPositiveSchema,
});
export const explanationStoredSchema = v.strictObject({
  status: v.literal("stored"),
});
export const explanationPermissionSchema = v.strictObject({
  status: v.literal("permission"),
  requestOrdinal: insightArtifactPositiveSchema,
  sha256: insightArtifactHashSchema,
  bytes: insightArtifactPositiveSchema,
});

/** Checks encoded bytes before parsing untrusted JSON with the admitted schema. */
export function parseExplanationFrameLine<TSchema extends v.GenericSchema>(
  schema: TSchema,
  line: string,
): Result<v.InferOutput<TSchema>, "frame_too_large" | "invalid_frame"> {
  if (new TextEncoder().encode(line).length > EXPLANATION_MAX_FRAME_BYTES)
    return err("frame_too_large");
  try {
    const parsed = v.safeParse(schema, JSON.parse(line));
    return parsed.success ? ok(parsed.output) : err("invalid_frame");
  } catch {
    return err("invalid_frame");
  }
}

/** Oversized frames are refused, never truncated. Callers supply their closed protocol type. */
export function encodeExplanationFrameLine<TFrame extends ExplanationFrame>(
  frame: TFrame,
): Result<string, "frame_too_large"> {
  const line = JSON.stringify(frame);
  return new TextEncoder().encode(line).length > EXPLANATION_MAX_FRAME_BYTES
    ? err("frame_too_large")
    : ok(line);
}
