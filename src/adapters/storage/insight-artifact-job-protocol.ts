import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import * as v from "valibot";

import { err, type Result } from "#src/domain/result";
import { parseContentHash, type ContentHash } from "#src/domain/ids";
import { isNotFound, type StorageFailure } from "./json-file";

const requestId = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
// The path stays bounded before structured clone allocates a message.
const boundedPath = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));

/** Private job-worker request; the first job hashes one file the caller already trusts. */
export const insightArtifactJobRequestSchema = v.strictObject({
  kind: v.literal("hash_file"),
  id: requestId,
  path: boundedPath,
});

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
