import * as v from "valibot";

import { MAX_INSIGHT_OBJECT_BYTES } from "./insight-artifact-files";

const requestId = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
// Both strings remain bounded before structured clone allocates a message.
const boundedPath = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));

/** Private read-only worker request; filesystem authority stays with the physical reader. */
export const insightArtifactWorkerRequestSchema = v.strictObject({
  kind: v.literal("read"),
  id: requestId,
  ownedRoot: boundedPath,
  path: boundedPath,
});

/** Correlation and bounded paths after private transport validation. */
export type InsightArtifactWorkerRequest = v.InferOutput<
  typeof insightArtifactWorkerRequestSchema
>;

const readResult = v.union([
  v.strictObject({
    _tag: v.literal("ok"),
    value: v.pipe(
      v.instance(Uint8Array),
      v.check(
        (bytes) =>
          bytes.byteLength <= MAX_INSIGHT_OBJECT_BYTES &&
          bytes.buffer instanceof ArrayBuffer &&
          bytes.buffer.byteLength <= MAX_INSIGHT_OBJECT_BYTES,
      ),
    ),
  }),
  v.strictObject({
    _tag: v.literal("err"),
    error: v.strictObject({
      _tag: v.literal("StorageFailure"),
      operation: v.literal("read"),
      reason: v.picklist([
        "not_found",
        "invalid_json",
        "invalid_stored_value",
        "sensitive_value",
        "io",
      ]),
    }),
  }),
]);

/** Ready is distinct from Node's online event and follows handler installation. */
export const insightArtifactWorkerReplySchema = v.union([
  v.strictObject({ kind: v.literal("ready") }),
  v.strictObject({
    kind: v.literal("read"),
    id: requestId,
    result: readResult,
  }),
]);
