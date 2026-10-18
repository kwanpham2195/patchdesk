import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import {
  parseWrappedInsightSlotRecord3,
  type InsightSlotRecord3,
} from "#src/domain/insight-slot-contract";
import { err, ok, type Result } from "#src/domain/result";
import { isNotFound, type StorageFailure } from "./json-file";
import { isPathContained } from "./path-containment";
import type { PatchdeskPaths } from "./patchdesk-paths";

const MAX_INSIGHT_OBJECT_BYTES = 16 * 1024;

/** Stateless immutable-object reads; this store never creates or repairs storage. */
export class InsightArtifactStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  /** Verifies the complete SlotRecord3 wrapper, not its transitive referenced graph. */
  async readSlotRecord3(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    reference: InsightArtifactReference,
  ): Promise<Result<InsightSlotRecord3, StorageFailure>> {
    const path = this.paths.insightArtifactObjectFile(
      profileId,
      reviewId,
      reference.hash,
    );
    if (path._tag === "err") return artifactReadFailure("invalid_stored_value");
    const bytes = await readBoundedInsightArtifactFile(
      this.paths.dataDirectory(),
      path.value,
    );
    if (bytes._tag === "err")
      return bytes.error.reason === "not_found"
        ? artifactReadFailure("invalid_stored_value")
        : bytes;
    if (
      bytes.value.length !== reference.bytes ||
      createHash("sha256").update(bytes.value).digest("hex") !== reference.hash
    )
      return artifactReadFailure("invalid_stored_value");
    const parsed = parseWrappedInsightSlotRecord3(bytes.value);
    return parsed._tag === "err"
      ? artifactReadFailure("invalid_stored_value")
      : parsed;
  }
}

/** Reads at most 16 KiB plus one EOF byte; only an observed missing path is not_found. */
export async function readBoundedInsightArtifactFile(
  ownedRoot: string,
  path: string,
): Promise<Result<Uint8Array, StorageFailure>> {
  try {
    const parents = await readOwnedParents(ownedRoot, path);
    if (parents._tag === "err") return parents;
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (cause: unknown) {
      return artifactReadFailure(isNotFound(cause) ? "not_found" : "io");
    }
    if (!isOwnedRegularFile(before) || before.size > MAX_INSIGHT_OBJECT_BYTES)
      return artifactReadFailure("invalid_stored_value");
    const root = await realpath(ownedRoot);
    const target = await realpath(path);
    if (!isPathContained(root, target))
      return artifactReadFailure("invalid_stored_value");
    // NONBLOCK prevents a swapped FIFO from blocking before fstat can reject it.
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await file.stat();
      if (!isOwnedRegularFile(opened) || !sameFile(before, opened))
        return artifactReadFailure("invalid_stored_value");
      const buffer = Buffer.alloc(MAX_INSIGHT_OBJECT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_INSIGHT_OBJECT_BYTES || length !== opened.size)
        return artifactReadFailure("invalid_stored_value");
      const after = await file.stat();
      if (!sameFile(opened, after) || !sameFile(after, await lstat(path)))
        return artifactReadFailure("invalid_stored_value");
      const checkedParents = await readOwnedParents(ownedRoot, path);
      if (checkedParents._tag === "err") return artifactReadFailure("io");
      if (
        parents.value.length !== checkedParents.value.length ||
        parents.value.some((parent, index) => {
          const checked = checkedParents.value[index];
          return (
            checked === undefined ||
            parent.dev !== checked.dev ||
            parent.ino !== checked.ino
          );
        })
      )
        return artifactReadFailure("invalid_stored_value");
      return ok(buffer.subarray(0, length));
    } finally {
      await file.close();
    }
  } catch {
    // ENOENT after discovery is a race or failed read, not authoritative absence.
    return artifactReadFailure("io");
  }
}

async function readOwnedParents(
  root: string,
  path: string,
): Promise<Result<ReadonlyArray<Stats>, StorageFailure>> {
  const resolvedRoot = resolve(root);
  let parent = dirname(resolve(path));
  if (!isPathContained(resolvedRoot, parent))
    return artifactReadFailure("invalid_stored_value");
  const paths: string[] = [];
  for (;;) {
    paths.push(parent);
    if (parent === resolvedRoot) break;
    parent = dirname(parent);
  }
  const parents: Stats[] = [];
  for (const candidate of paths.reverse()) {
    let metadata: Stats;
    try {
      metadata = await lstat(candidate);
    } catch (cause: unknown) {
      return artifactReadFailure(isNotFound(cause) ? "not_found" : "io");
    }
    if (!metadata.isDirectory() || !isOwned(metadata))
      return artifactReadFailure("invalid_stored_value");
    parents.push(metadata);
  }
  return ok(parents);
}

function isOwned(metadata: Stats): boolean {
  const uid = process.geteuid?.();
  return (
    uid !== undefined && metadata.uid === uid && (metadata.mode & 0o022) === 0
  );
}

function isOwnedRegularFile(metadata: Stats): boolean {
  return metadata.isFile() && isOwned(metadata);
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    isOwned(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function artifactReadFailure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason });
}
