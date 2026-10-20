import { createHash } from "node:crypto";
import * as v from "valibot";

import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import { insightBlobBlockCodec } from "#src/domain/insight-artifact-index";
import {
  insightTextRootDescriptorSchema,
  type InsightArtifactReference,
  type InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import { MAX_INSIGHT_OBJECT_BYTES } from "./insight-artifact-files";
import type { InsightArtifactStore } from "./insight-artifact-store";
import { InsightBlobIndexBuilder } from "./insight-index-builder";
import { InsightSensitiveStream } from "./insight-sensitive-stream";
import type { StorageFailure } from "./json-file";
import type { InsightCaptureSourceFile } from "./insight-capture-source-file";

const scanUnits = 4096;
type InstallTextBlob = (
  bytes: Uint8Array,
) => Promise<Result<InsightArtifactReference, StorageFailure>>;

/** Scans immutable metadata completely before installing bounded blocks; never encodes the whole string. */
export async function writeInsightTextRoot(
  artifacts: Pick<InsightArtifactStore, "writeObject">,
  profileId: WorkspaceProfileId,
  reviewId: ReviewId,
  text: string,
  installBlob: InstallTextBlob,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<InsightTextRootDescriptor, StorageFailure>> {
  const sensitive = new InsightSensitiveStream();
  let pendingHighSurrogate = false;
  for (let start = 0; start < text.length; start += scanUnits) {
    // The scan is synchronous CPU; checking each chunk lets an abort win before any block is installed.
    if (options.signal?.aborted) return writeFailure("io");
    const chunk = text.slice(start, start + scanUnits);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const unit = chunk.charCodeAt(offset);
      if (pendingHighSurrogate) {
        if (unit < 0xdc00 || unit > 0xdfff)
          return writeFailure("invalid_stored_value");
        pendingHighSurrogate = false;
      } else if (unit >= 0xd800 && unit <= 0xdbff) pendingHighSurrogate = true;
      else if (unit >= 0xdc00 && unit <= 0xdfff)
        return writeFailure("invalid_stored_value");
    }
    sensitive.push(chunk);
  }
  if (pendingHighSurrogate) return writeFailure("invalid_stored_value");
  if (sensitive.finish()) return writeFailure("sensitive_value");

  let offset = 0;
  return writeValidatedText(
    artifacts,
    profileId,
    reviewId,
    installBlob,
    async () => {
      if (offset === text.length) return ok(undefined);
      let end = Math.min(offset + scanUnits, text.length);
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      const chunk = text.slice(offset, end);
      offset = end;
      return ok(chunk);
    },
    options,
  );
}

/** Consumes only an already scanned private snapshot, never a reopened mutable source path. */
export async function writeInsightSnapshotTextRoot(
  artifacts: Pick<InsightArtifactStore, "writeObject">,
  profileId: WorkspaceProfileId,
  reviewId: ReviewId,
  snapshot: InsightCaptureSourceFile,
  installBlob: InstallTextBlob,
  options: { readonly signal?: AbortSignal },
): Promise<Result<InsightTextRootDescriptor, StorageFailure>> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let ended = false;
  return writeValidatedText(
    artifacts,
    profileId,
    reviewId,
    installBlob,
    async () => {
      if (ended) return ok(undefined);
      try {
        for (;;) {
          const read = await snapshot.read();
          if (read._tag === "err") return read;
          if (read.value === undefined) {
            ended = true;
            return ok(decoder.decode());
          }
          const text = decoder.decode(read.value, { stream: true });
          if (text.length > 0) return ok(text);
        }
      } catch {
        return writeFailure("invalid_stored_value");
      }
    },
    options,
  );
}

async function writeValidatedText(
  artifacts: Pick<InsightArtifactStore, "writeObject">,
  profileId: WorkspaceProfileId,
  reviewId: ReviewId,
  installBlob: InstallTextBlob,
  readText: () => Promise<Result<string | undefined, StorageFailure>>,
  options: { readonly signal?: AbortSignal },
): Promise<Result<InsightTextRootDescriptor, StorageFailure>> {
  const index = new InsightBlobIndexBuilder(artifacts, profileId, reviewId);
  const digest = createHash("sha256");
  let bytes = 0;
  let utf16Units = 0;
  let block = Buffer.alloc(MAX_INSIGHT_OBJECT_BYTES);
  let length = 0;
  const encoder = new TextEncoder();

  async function flush(): Promise<Result<void, StorageFailure>> {
    if (options.signal?.aborted) return writeFailure("io");
    const nextBytes = bytes + length;
    if (!Number.isSafeInteger(nextBytes))
      return writeFailure("invalid_stored_value");
    const raw = block.subarray(0, length);
    const blob = await installBlob(raw);
    if (blob._tag === "err") return blob;
    const stored = await artifacts.writeObject(
      profileId,
      reviewId,
      insightBlobBlockCodec,
      { byteStart: bytes, bytes: blob.value },
    );
    if (stored._tag === "err") return stored;
    const appended = await index.append(stored.value);
    if (appended._tag === "err") return appended;
    digest.update(raw);
    bytes = nextBytes;
    block = Buffer.alloc(MAX_INSIGHT_OBJECT_BYTES);
    length = 0;
    return ok(undefined);
  }

  for (;;) {
    if (options.signal?.aborted) return writeFailure("io");
    const read = await readText();
    if (read._tag === "err") return read;
    if (read.value === undefined) break;
    for (let start = 0; start < read.value.length;) {
      // encodeInto stops before a scalar that would exceed the remaining raw block space.
      const chunk = read.value.slice(start);
      const encoded = encoder.encodeInto(chunk, block.subarray(length));
      start += encoded.read;
      utf16Units += encoded.read;
      length += encoded.written;
      if (!Number.isSafeInteger(utf16Units))
        return writeFailure("invalid_stored_value");
      if (encoded.read < chunk.length || length === MAX_INSIGHT_OBJECT_BYTES) {
        const flushed = await flush();
        if (flushed._tag === "err") return flushed;
      }
    }
  }
  if (options.signal?.aborted) return writeFailure("io");
  if (length > 0) {
    const flushed = await flush();
    if (flushed._tag === "err") return flushed;
  }
  const blocks = await index.finish();
  if (blocks._tag === "err") return blocks;
  const root = v.safeParse(insightTextRootDescriptorSchema, {
    data: { blocks: blocks.value, bytes, sha256: digest.digest("hex") },
    utf16Units,
  });
  return root.success ? ok(root.output) : writeFailure("invalid_stored_value");
}

function writeFailure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "write", reason });
}
