import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import * as v from "valibot";

import { err, type Result } from "#src/domain/result";
import {
  parseContentHash,
  parseGitSha,
  parseInsightRunId,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ContentHash,
} from "#src/domain/ids";
import { isNotFound, type StorageFailure } from "./json-file";
import { guidePreparationResultSchema } from "#src/domain/guide-preparation";
import {
  insightArtifactReferenceSchema,
  insightArtifactUnsignedSchema,
  insightTextRootDescriptorSchema,
} from "#src/domain/insight-artifact-scalars";

const requestId = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
// The path stays bounded before structured clone allocates a message.
const boundedPath = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));

/** Private job-worker request; the first job hashes one file the caller already trusts. */
const hashRequest = v.strictObject({
  kind: v.literal("hash_file"),
  id: requestId,
  path: boundedPath,
});

/** Main-derived locations only; no source content or renderer-supplied path crosses this channel. */
const insightPatchCaptureInputSchema = v.strictObject({
  sourceRoot: boundedPath,
  sourcePath: boundedPath,
  destinationRoot: boundedPath,
  destinationReview: boundedPath,
  profileId: v.pipe(
    v.string(),
    v.check((value) => parseWorkspaceProfileId(value)._tag === "ok"),
  ),
  reviewId: v.pipe(
    v.string(),
    v.check((value) => parseReviewId(value)._tag === "ok"),
  ),
  sessionId: v.pipe(
    v.string(),
    v.check((value) => parseReviewSessionId(value)._tag === "ok"),
  ),
  expectedHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

/** Parsed, bounded arguments for the physical patch operation. */
export type InsightPatchCaptureInput = v.InferOutput<
  typeof insightPatchCaptureInputSchema
>;

/** Main-derived locations and identities for one Guide preparation; the context input is a private hash-bound file. */
const guidePreparationInputSchema = v.strictObject({
  ...insightPatchCaptureInputSchema.entries,
  runId: v.pipe(
    v.string(),
    v.check((value) => parseInsightRunId(value)._tag === "ok"),
  ),
  headSha: v.pipe(
    v.string(),
    v.check((value) => parseGitSha(value)._tag === "ok"),
  ),
  baseSha: v.pipe(
    v.string(),
    v.check((value) => parseGitSha(value)._tag === "ok"),
  ),
  binding: insightArtifactReferenceSchema,
  contextPath: boundedPath,
  contextHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  contextBytes: insightArtifactUnsignedSchema,
});

/** Parsed, bounded arguments for the Guide preparation operation. */
export type GuidePreparationInput = v.InferOutput<
  typeof guidePreparationInputSchema
>;

const patchFailureSchema = v.strictObject({
  _tag: v.literal("InsightPatchFailure"),
  reason: v.picklist([
    "aborted",
    "invalid_source",
    "stale_source",
    "sensitive_value",
    "too_large",
    "io",
    "transport",
    "busy",
  ]),
});

/** Safe failure categories carry no source paths, prose or caught exception messages. */
export type InsightPatchFailure = v.InferOutput<typeof patchFailureSchema>;

/** A verified patch descriptor, not a CaptureRoot or publication receipt. */
export type InsightPatchCaptureResult = Result<
  v.InferOutput<typeof insightTextRootDescriptorSchema>,
  InsightPatchFailure
>;

/** Safe failure categories carry no source paths, prose or caught exception messages. */
export type GuidePreparationFailure = Extract<
  GuidePreparationResult,
  { readonly _tag: "err" }
>["error"];

/** A stored, fully verified GuidePreparedInput1 root, not a generated result. */
export type GuidePreparationResult = v.InferOutput<
  typeof guidePreparationResultSchema
>;

/** Constructs a prose-free Guide preparation failure. */
export function guidePreparationFailure(
  reason: GuidePreparationFailure["reason"],
): Result<never, GuidePreparationFailure> {
  return err({ _tag: "GuidePreparationFailure", reason });
}

/** Constructs a prose-free patch failure. */
export function patchCaptureFailure(
  reason: InsightPatchFailure["reason"],
): Result<never, InsightPatchFailure> {
  return err({ _tag: "InsightPatchFailure", reason });
}

/** Correlated operation and cancellation messages; cancellation grants no new filesystem authority. */
export const insightArtifactJobRequestSchema = v.pipe(
  v.variant("kind", [
    hashRequest,
    v.strictObject({
      kind: v.literal("capture_patch"),
      id: requestId,
      input: insightPatchCaptureInputSchema,
    }),
    v.strictObject({
      kind: v.literal("prepare_guide"),
      id: requestId,
      input: guidePreparationInputSchema,
    }),
    v.strictObject({ kind: v.literal("cancel"), id: requestId }),
  ]),
  v.check((request) => {
    const strings =
      request.kind === "capture_patch"
        ? Object.values(request.input)
        : request.kind === "prepare_guide"
          ? [
              request.input.sourceRoot,
              request.input.sourcePath,
              request.input.destinationRoot,
              request.input.destinationReview,
              request.input.contextPath,
            ]
          : request.kind === "hash_file"
            ? [request.path]
            : [];
    // The code-unit lower bound avoids allocating an oversized JSON string before checking actual encoded bytes.
    return (
      strings.reduce((sum, value) => sum + value.length, 0) <= 32 * 1024 &&
      Buffer.byteLength(JSON.stringify(request), "utf8") <= 32 * 1024
    );
  }),
);

/** Correlation and bounded path after private transport validation. */
export type InsightArtifactJobRequest = v.InferOutput<
  typeof insightArtifactJobRequestSchema
>;

const hashResult = v.union([
  v.strictObject({
    _tag: v.literal("ok"),
    value: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  }),
  v.strictObject({
    _tag: v.literal("err"),
    error: v.strictObject({
      _tag: v.literal("StorageFailure"),
      operation: v.literal("read"),
      reason: v.picklist(["not_found", "io"]),
    }),
  }),
]);

/** Ready is distinct from Node's online event and follows handler installation. */
export const insightArtifactJobReplySchema = v.union([
  v.strictObject({ kind: v.literal("ready") }),
  v.strictObject({
    kind: v.literal("hash_file"),
    id: requestId,
    result: hashResult,
  }),
  v.strictObject({
    kind: v.literal("capture_patch"),
    id: requestId,
    result: v.variant("_tag", [
      v.strictObject({
        _tag: v.literal("ok"),
        value: insightTextRootDescriptorSchema,
      }),
      v.strictObject({ _tag: v.literal("err"), error: patchFailureSchema }),
    ]),
  }),
  v.strictObject({
    kind: v.literal("prepare_guide"),
    id: requestId,
    result: guidePreparationResultSchema,
  }),
]);

const hashBlockBytes = 64 * 1024;

/**
 * SHA-256 of the file as `readFile(path, "utf8")` decodes it, re-encoded as
 * UTF-8, read in fixed blocks. `ignoreBOM: true` keeps a leading U+FEFF, as
 * the Buffer decoder does, and the final `decode()` flushes a truncated
 * sequence to U+FFFD, so malformed input hashes the same as the whole-file read.
 */
export async function hashUtf8FileSha256(
  path: string,
): Promise<Result<ContentHash, StorageFailure>> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY);
  } catch (cause: unknown) {
    return readFailure(isNotFound(cause) ? "not_found" : "io");
  }
  try {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const hash = createHash("sha256");
    const block = Buffer.allocUnsafe(hashBlockBytes);
    for (;;) {
      // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- each block read depends on the previous decoder state
      const read = await file.read(block, 0, block.length, null);
      if (read.bytesRead === 0) break;
      hash.update(
        decoder.decode(block.subarray(0, read.bytesRead), { stream: true }),
      );
    }
    hash.update(decoder.decode());
    const parsed = parseContentHash(hash.digest("hex"));
    return parsed._tag === "ok" ? parsed : readFailure("io");
  } catch {
    return readFailure("io");
  } finally {
    // A close failure after a completed read cannot change the digest.
    await file.close().catch(() => undefined);
  }
}

function readFailure(
  reason: "not_found" | "io",
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason });
}
