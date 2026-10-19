import * as v from "valibot";

import {
  insightArtifactReferenceSchema,
  insightArtifactUnsignedSchema,
  parseInsightArtifactCanonicalJson,
} from "./insight-artifact-scalars";
import { err, ok, type Result } from "./result";

const MAX_INDEX_KEY_BYTES = 256;

/** K: nonempty ASCII, so UTF-16 string order equals byte order. */
const indexKeySchema = v.pipe(
  v.string(),
  v.check(
    (key) =>
      key.length >= 1 &&
      key.length <= MAX_INDEX_KEY_BYTES &&
      Array.from(key).every((character) => character.charCodeAt(0) < 0x80),
  ),
);

const blobIndexNodeSchema = v.variant("tag", [
  v.strictObject({
    tag: v.literal("leaf"),
    entries: v.array(
      v.strictObject({
        key: indexKeySchema,
        value: insightArtifactReferenceSchema,
      }),
    ),
  }),
  v.strictObject({
    tag: v.literal("branch"),
    children: v.array(
      v.strictObject({
        first: indexKeySchema,
        last: indexKeySchema,
        count: insightArtifactUnsignedSchema,
        root: insightArtifactReferenceSchema,
      }),
    ),
  }),
]);

const wrappedBlobIndexNodeSchema = v.strictObject({
  format: v.literal(2),
  schema: v.literal("Index<BlobBlock>"),
  value: blobIndexNodeSchema,
});

const blobBlockSchema = v.strictObject({
  byteStart: insightArtifactUnsignedSchema,
  bytes: insightArtifactReferenceSchema,
});

const wrappedBlobBlockSchema = v.strictObject({
  format: v.literal(2),
  schema: v.literal("BlobBlock"),
  value: blobBlockSchema,
});

/** Index<BlobBlock> node shape only; key order, counts and child ranges are checked while traversing. */
export type InsightBlobIndexNode = v.InferOutput<typeof blobIndexNodeSchema>;

/** BlobBlock shape only; contiguity and blob contents are checked while traversing. */
export type InsightBlobBlock = v.InferOutput<typeof blobBlockSchema>;

type InvalidInsightBlobObject = {
  readonly _tag: "InvalidInsightBlobObject";
};

/** Parses one exact canonical Index<BlobBlock> wrapper without following any reference. */
export function parseWrappedInsightBlobIndexNode(
  bytes: Uint8Array,
): Result<InsightBlobIndexNode, InvalidInsightBlobObject> {
  const parsed = parseInsightArtifactCanonicalJson(
    bytes,
    wrappedBlobIndexNodeSchema,
  );
  return parsed._tag === "err"
    ? err({ _tag: "InvalidInsightBlobObject" })
    : ok(parsed.value.value);
}

/** Parses one exact canonical BlobBlock wrapper without reading its blob. */
export function parseWrappedInsightBlobBlock(
  bytes: Uint8Array,
): Result<InsightBlobBlock, InvalidInsightBlobObject> {
  const parsed = parseInsightArtifactCanonicalJson(
    bytes,
    wrappedBlobBlockSchema,
  );
  return parsed._tag === "err"
    ? err({ _tag: "InvalidInsightBlobObject" })
    : ok(parsed.value.value);
}
