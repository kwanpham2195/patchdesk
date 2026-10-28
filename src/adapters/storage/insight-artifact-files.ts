import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { err, ok, type Result } from "#src/domain/result";
import { isNotFound, type StorageFailure } from "./json-file";
import { isPathContained } from "./path-containment";

/** The complete immutable wrapper, not just its value, must fit this bound. */
export const MAX_INSIGHT_OBJECT_BYTES = 16 * 1024;

/** Reads at most 16 KiB plus one EOF byte; only an observed missing path is not_found. */
export async function readBoundedInsightArtifactFile(
  ownedRoot: string,
  path: string,
): Promise<Result<Uint8Array, StorageFailure>> {
  return readArtifactFile(ownedRoot, path);
}

async function readArtifactFile(
  ownedRoot: string,
  path: string,
  durableBytes?: Uint8Array,
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
      if (durableBytes !== undefined) {
        if (!buffer.subarray(0, length).equals(durableBytes))
          return artifactReadFailure("invalid_stored_value");
        await file.sync();
      }
      const after = await file.stat();
      if (!sameFile(opened, after) || !sameFile(after, await lstat(path)))
        return artifactReadFailure("invalid_stored_value");
      const checkedParents = await readOwnedParents(ownedRoot, path);
      if (checkedParents._tag === "err") return artifactReadFailure("io");
      if (!sameParents(parents.value, checkedParents.value))
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

/** Installs only current-namespace objects; failure never removes a possibly installed final object. */
export async function installImmutableInsightArtifactFile(
  ownedRoot: string,
  reviewDirectory: string,
  path: string,
  bytes: Uint8Array,
): Promise<Result<void, StorageFailure>> {
  const namespace = join(resolve(reviewDirectory), "insight-artifacts-v2");
  const objects = join(namespace, "objects");
  if (
    bytes.length > MAX_INSIGHT_OBJECT_BYTES ||
    dirname(resolve(path)) !== objects ||
    basename(path) !==
      `${createHash("sha256").update(bytes).digest("hex")}.json`
  )
    return artifactWriteFailure("invalid_stored_value");
  try {
    const ancestors = await readOwnedParents(
      ownedRoot,
      join(reviewDirectory, ".check"),
    );
    if (ancestors._tag === "err")
      return artifactWriteFailure(ancestors.error.reason);
    if (
      !isPathContained(
        await realpath(ownedRoot),
        await realpath(reviewDirectory),
      )
    )
      return artifactWriteFailure("invalid_stored_value");
    for (const directory of [namespace, objects]) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (cause: unknown) {
        if (
          !(
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "EEXIST"
          )
        )
          return artifactWriteFailure("io");
      }
      const checked = await readOwnedParents(
        ownedRoot,
        join(directory, ".check"),
      );
      if (checked._tag === "err")
        return artifactWriteFailure(
          checked.error.reason === "not_found" ? "io" : checked.error.reason,
        );
      if (
        !sameParents(
          ancestors.value,
          checked.value.slice(0, ancestors.value.length),
        )
      )
        return artifactWriteFailure("invalid_stored_value");
    }
    const parents = await readOwnedParents(ownedRoot, path);
    if (parents._tag === "err")
      return artifactWriteFailure(
        parents.error.reason === "not_found" ? "io" : parents.error.reason,
      );
    const installed = await stageImmutableFile(
      ownedRoot,
      path,
      bytes,
      parents.value,
    );
    if (installed._tag === "err") return installed;
    const beforeVerification = await lstat(path);
    const verified = await verifyInstalledImmutableFile(
      ownedRoot,
      [objects, namespace, resolve(reviewDirectory)],
      path,
      bytes,
      parents.value,
      beforeVerification,
    );
    if (verified._tag === "ok") return verified;
    const afterVerification = await lstat(path);
    if (
      beforeVerification.nlink !== 2 ||
      afterVerification.nlink !== 1 ||
      beforeVerification.dev !== afterVerification.dev ||
      beforeVerification.ino !== afterVerification.ino ||
      beforeVerification.size !== afterVerification.size ||
      beforeVerification.mtimeMs !== afterVerification.mtimeMs ||
      !isOwnedRegularFile(afterVerification)
    )
      return verified;
    return await verifyInstalledImmutableFile(
      ownedRoot,
      [objects, namespace, resolve(reviewDirectory)],
      path,
      bytes,
      parents.value,
      afterVerification,
    );
  } catch {
    return artifactWriteFailure("io");
  }
}

async function verifyInstalledImmutableFile(
  ownedRoot: string,
  directories: ReadonlyArray<string>,
  path: string,
  bytes: Uint8Array,
  parents: ReadonlyArray<Stats>,
  beforeVerification: Stats,
): Promise<Result<void, StorageFailure>> {
  const verified = await readArtifactFile(ownedRoot, path, bytes);
  if (verified._tag === "err")
    return artifactWriteFailure(
      verified.error.reason === "not_found" ? "io" : verified.error.reason,
    );
  // Sync every namespace entry even on reuse after another writer's uncertain fsync.
  for (const directory of directories) {
    const synced = await syncOwnedDirectory(directory);
    if (synced._tag === "err") return synced;
  }
  const checked = await readOwnedParents(ownedRoot, path);
  return checked._tag === "ok" &&
    sameParents(parents, checked.value) &&
    sameFile(beforeVerification, await lstat(path))
    ? ok(undefined)
    : artifactWriteFailure("io");
}

async function stageImmutableFile(
  ownedRoot: string,
  path: string,
  bytes: Uint8Array,
  parents: ReadonlyArray<Stats>,
): Promise<Result<void, StorageFailure>> {
  const staged = await stageOwnedTemporaryFile(ownedRoot, path, bytes, parents);
  if (staged._tag === "err") return staged;
  let outcome: Result<void, StorageFailure> = ok(undefined);
  try {
    const checked = await readOwnedParents(ownedRoot, path);
    if (checked._tag === "err" || !sameParents(parents, checked.value))
      outcome = artifactWriteFailure("io");
    else {
      try {
        await link(staged.value.path, path);
      } catch (cause: unknown) {
        if (
          !(
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "EEXIST"
          )
        )
          outcome = artifactWriteFailure("io");
      }
    }
  } catch {
    outcome = artifactWriteFailure("io");
  }
  const removed = await removeStagedTemporaryFile(
    ownedRoot,
    path,
    staged.value,
    parents,
    false,
  );
  return removed._tag === "err" ? removed : outcome;
}

/** A temporary file this process exclusively created, identified by inode so cleanup never removes a swapped-in file. */
type StagedTemporaryFile = {
  readonly path: string;
  readonly identity: Stats;
};

/** Exclusively creates a sibling temporary file for `path`, writes and fsyncs `bytes`; a failure removes the file it created. */
export async function stageOwnedTemporaryFile(
  ownedRoot: string,
  path: string,
  bytes: Uint8Array,
  parents: ReadonlyArray<Stats>,
): Promise<Result<StagedTemporaryFile, StorageFailure>> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let identity: Stats | undefined;
  let outcome: Result<void, StorageFailure> = artifactWriteFailure("io");
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      identity = await file.stat();
      if (isOwnedRegularFile(identity)) {
        await file.writeFile(bytes);
        await file.sync();
        const written = await file.stat();
        outcome =
          written.size === bytes.length &&
          written.dev === identity.dev &&
          written.ino === identity.ino &&
          sameFile(written, await lstat(temporary))
            ? ok(undefined)
            : artifactWriteFailure("invalid_stored_value");
      } else outcome = artifactWriteFailure("invalid_stored_value");
    } finally {
      await file.close();
    }
  } catch {
    outcome = artifactWriteFailure("io");
  }
  if (identity === undefined) return artifactWriteFailure("io");
  const staged = { path: temporary, identity };
  if (outcome._tag === "ok") return ok(staged);
  const removed = await removeStagedTemporaryFile(
    ownedRoot,
    path,
    staged,
    parents,
    false,
  );
  return removed._tag === "err" ? removed : outcome;
}

/** Unlinks the staged file only while the parent chain and the file's dev/ino are unchanged; `mayBeGone` accepts a rename that already consumed it. */
export async function removeStagedTemporaryFile(
  ownedRoot: string,
  path: string,
  staged: StagedTemporaryFile,
  parents: ReadonlyArray<Stats>,
  mayBeGone: boolean,
): Promise<Result<void, StorageFailure>> {
  try {
    const checked = await readOwnedParents(ownedRoot, path);
    if (checked._tag === "err" || !sameParents(parents, checked.value))
      return artifactWriteFailure("io");
    let current: Stats;
    try {
      current = await lstat(staged.path);
    } catch (cause: unknown) {
      return mayBeGone && isNotFound(cause)
        ? ok(undefined)
        : artifactWriteFailure("io");
    }
    if (
      !isOwnedRegularFile(current) ||
      current.dev !== staged.identity.dev ||
      current.ino !== staged.identity.ino
    )
      return artifactWriteFailure("io");
    await unlink(staged.path);
    return ok(undefined);
  } catch {
    return artifactWriteFailure("io");
  }
}

export async function syncOwnedDirectory(
  path: string,
): Promise<Result<void, StorageFailure>> {
  const before = await lstat(path);
  if (!before.isDirectory() || !isOwned(before))
    return artifactWriteFailure("invalid_stored_value");
  const directory = await open(
    path,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const opened = await directory.stat();
    if (!sameParents([before], [opened]))
      return artifactWriteFailure("invalid_stored_value");
    await directory.sync();
    const after = await directory.stat();
    return sameParents([opened], [after]) &&
      sameParents([after], [await lstat(path)])
      ? ok(undefined)
      : artifactWriteFailure("io");
  } finally {
    await directory.close();
  }
}

export async function readOwnedParents(
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

export function sameParents(
  left: ReadonlyArray<Stats>,
  right: ReadonlyArray<Stats>,
): boolean {
  return (
    left.length === right.length &&
    left.every((parent, index) => {
      const checked = right[index];
      return (
        checked !== undefined &&
        checked.isDirectory() &&
        isOwned(checked) &&
        parent.dev === checked.dev &&
        parent.ino === checked.ino
      );
    })
  );
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

function artifactWriteFailure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "write", reason });
}
