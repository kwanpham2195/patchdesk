import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { WorkspaceProfileId } from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import type { PatchdeskPaths } from "./patchdesk-paths";

export type AvatarCacheFailure = {
  readonly _tag: "AvatarCacheFailure";
  readonly operation: "read" | "write";
  readonly reason: "not_found" | "io";
};

/**
 * Deterministic cache key for one avatar URL. GitHub re-versions the URL
 * whenever the underlying image changes (e.g. a trailing `?v=4` bump), so
 * hashing the URL as given doubles as the cache's invalidation key: a
 * changed avatar hashes to a fresh, uncached entry rather than overwriting
 * stale bytes under a reused name.
 */
export function hashAvatarUrl(avatarUrl: string): string {
  return createHash("sha256").update(avatarUrl).digest("hex");
}

/** True when this profile already has bytes cached for `avatarHash`. */
export async function hasAvatar(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  avatarHash: string,
): Promise<boolean> {
  try {
    await readFile(paths.avatarFile(profileId, avatarHash));
    return true;
  } catch {
    return false;
  }
}

/** Read the raw cached bytes for one avatar. */
export async function readAvatar(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  avatarHash: string,
): Promise<Result<Uint8Array, AvatarCacheFailure>> {
  try {
    const bytes = await readFile(paths.avatarFile(profileId, avatarHash));
    return ok(new Uint8Array(bytes));
  } catch (cause) {
    return err({
      _tag: "AvatarCacheFailure",
      operation: "read",
      reason: isNotFound(cause) ? "not_found" : "io",
    });
  }
}

/** Persist raw avatar bytes for one profile, replacing any prior cached entry. */
export async function writeAvatar(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  avatarHash: string,
  bytes: Uint8Array,
): Promise<Result<void, AvatarCacheFailure>> {
  const path = paths.avatarFile(profileId, avatarHash);
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    return ok(undefined);
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return err({ _tag: "AvatarCacheFailure", operation: "write", reason: "io" });
  }
}

/**
 * Read a cached avatar back as a `data:` URI, the only form the renderer's
 * `img-src 'self' data:` CSP allows an `<img>` to point at. Content type is
 * sniffed from the stored bytes' magic number rather than kept in a sidecar
 * file, so the cache stays exactly one raw-bytes file per avatar.
 */
export async function avatarDataUri(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  avatarHash: string,
): Promise<Result<string, AvatarCacheFailure>> {
  const read = await readAvatar(paths, profileId, avatarHash);
  if (read._tag === "err") return read;
  const contentType = sniffImageContentType(read.value);
  const base64 = Buffer.from(
    read.value.buffer,
    read.value.byteOffset,
    read.value.byteLength,
  ).toString("base64");
  return ok(`data:${contentType};base64,${base64}`);
}

/** Falls back to image/png (GitHub's own identicon format) for unrecognized bytes. */
function sniffImageContentType(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return "image/png";
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
