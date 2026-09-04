import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { WorkspaceProfileId } from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import { sniffImageContentType } from "./avatar-cache-store";
import { isNotFound, writeAtomicFile } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

export type PullRequestImageCacheFailure = {
  readonly _tag: "PullRequestImageCacheFailure";
  readonly operation: "read" | "write";
  readonly reason: "not_found" | "io" | "not_an_image";
};

/**
 * Deterministic cache key for one image URL. GitHub's user-attachment URLs
 * are immutable per upload, so hashing the URL as given is both the key and
 * the invalidation rule: a re-uploaded image gets a new URL and a fresh entry.
 */
export function hashPullRequestImageUrl(imageUrl: string): string {
  return createHash("sha256").update(imageUrl).digest("hex");
}

/**
 * Read cached image bytes back as a `data:` URI, the only form the renderer's
 * `img-src 'self' data:` CSP allows an `<img>` to point at. Bytes that no
 * longer sniff as an image are reported as `not_an_image` rather than being
 * labelled, so a corrupt entry falls back to a re-fetch instead of a broken
 * image.
 */
export async function readPullRequestImageDataUri(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  imageHash: string,
): Promise<Result<string, PullRequestImageCacheFailure>> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(
      await readFile(paths.pullRequestImageFile(profileId, imageHash)),
    );
  } catch (cause) {
    return err({
      _tag: "PullRequestImageCacheFailure",
      operation: "read",
      reason: isNotFound(cause) ? "not_found" : "io",
    });
  }
  const dataUri = imageDataUri(bytes);
  return dataUri === undefined
    ? err({
        _tag: "PullRequestImageCacheFailure",
        operation: "read",
        reason: "not_an_image",
      })
    : ok(dataUri);
}

/** Persist raw image bytes for one profile, replacing any prior cached entry. */
export async function writePullRequestImage(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  imageHash: string,
  bytes: Uint8Array,
): Promise<Result<void, PullRequestImageCacheFailure>> {
  const written = await writeAtomicFile(
    paths.pullRequestImageFile(profileId, imageHash),
    bytes,
  );
  return written._tag === "ok"
    ? ok(undefined)
    : err({
        _tag: "PullRequestImageCacheFailure",
        operation: "write",
        reason: "io",
      });
}

/** `data:` URI for freshly fetched bytes, or `undefined` when they are not an image. */
export function imageDataUri(bytes: Uint8Array): string | undefined {
  const contentType = sniffImageContentType(bytes);
  if (contentType === undefined) return undefined;
  const base64 = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("base64");
  return `data:${contentType};base64,${base64}`;
}
