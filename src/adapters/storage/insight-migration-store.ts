import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { PatchdeskPaths } from "./patchdesk-paths";
import { isPathContained } from "./path-containment";

/** This checkpoint has no migration authority and cannot be used as a retained result. */
export type AnalysisShadowCheckpoint = {
  readonly state: "properties_resolved";
  readonly sourceHash: string;
  readonly sourceBytes: number;
  readonly directory: string;
  readonly spool: {
    readonly tokens: number;
    readonly decodedCodeUnits: number;
    readonly sourceHash: string;
    readonly sourceBytes: number;
  };
  readonly structure: {
    readonly root: number;
    readonly values: number;
    readonly keys: number;
    readonly records: number;
    readonly maxDepth: number;
  };
  readonly properties: {
    readonly root: number;
    readonly nodeRows: number;
    readonly keyBytes: number;
    readonly sourceProperties: number;
    readonly duplicateProperties: number;
    readonly reachableValues: number;
    readonly selectedProperties: number;
    readonly arrayElements: number;
    readonly records: number;
    readonly indexRowBytes: 1024;
  };
  readonly pending: "sensitive_scan_schema_conversion_equality";
};

/** Fixed scratch descriptors remain storage-owned through lexical and structural processing. */
export type AnalysisShadowFiles = {
  readonly tokens: FileHandle;
  readonly frames: FileHandle;
  readonly structure: FileHandle;
  readonly nodes: FileHandle;
  readonly keys: FileHandle;
  readonly properties: FileHandle;
};

/** Private preparation failures never substitute an empty or healed Insight. */
export type AnalysisShadowFailure = {
  readonly _tag: "AnalysisShadowFailure";
  readonly reason:
    | "source_changed"
    | "backup_mismatch"
    | "invalid_legacy"
    | "invalid_spool"
    | "storage_unavailable"
    | "representation_exhausted"
    | "cancelled";
};

/** Captures original bytes outside preparation cleanup and spools only a private shadow input. */
export class InsightMigrationStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  /** Explicit internal preparation only; never changes the live schema-2 file or a slot pointer. */
  async prepareAnalysisShadow(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    spoolInput: (
      source: FileHandle,
      files: AnalysisShadowFiles,
    ) => Promise<
      Result<
        Pick<AnalysisShadowCheckpoint, "spool" | "structure" | "properties">,
        AnalysisShadowFailure
      >
    >,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<AnalysisShadowCheckpoint, AnalysisShadowFailure>> {
    const handles: FileHandle[] = [];
    try {
      options.signal?.throwIfAborted();
      const sourcePath = this.paths.insightFile(
        profileId,
        reviewId,
        "analysis",
      );
      await checkDirectoryChain(dirname(sourcePath));
      const source = await open(
        sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      handles.push(source);
      const before = await source.stat();
      if (!before.isFile()) return shadowFailure("storage_unavailable");
      const directory = this.paths.insightMigrationDirectory(
        profileId,
        reviewId,
      );
      await createPrivateDirectoryChain(this.paths.dataDirectory(), directory);
      const attempt = join(directory, randomUUID());
      await mkdir(attempt, { mode: 0o700 });
      await syncDirectory(directory);
      const backupPath = join(attempt, "source.json");
      const backup = await open(
        backupPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      handles.push(backup);
      if (!(await backup.stat()).isFile())
        return shadowFailure("storage_unavailable");
      const copied = await copyAndHash(source, backup, options.signal);
      await backup.sync();
      await syncDirectory(attempt);
      const verified = await open(
        backupPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      handles.push(verified);
      const verifiedBefore = await verified.stat();
      if (!verifiedBefore.isFile()) return shadowFailure("storage_unavailable");
      const reread = await copyAndHash(verified, undefined, options.signal);
      const current = await open(
        sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      handles.push(current);
      const after = await current.stat();
      if (!after.isFile()) return shadowFailure("storage_unavailable");
      const currentDigest = await copyAndHash(
        current,
        undefined,
        options.signal,
      );
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        copied.hash !== currentDigest.hash ||
        copied.bytes !== currentDigest.bytes
      )
        return shadowFailure("source_changed");
      if (reread.hash !== copied.hash || reread.bytes !== copied.bytes)
        return shadowFailure("backup_mismatch");
      const output = await open(
        join(attempt, "tokens.ndjson"),
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      handles.push(output);
      if (!(await output.stat()).isFile())
        return shadowFailure("storage_unavailable");
      const frames = await open(
        join(attempt, "frames.bin"),
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      handles.push(frames);
      if (!(await frames.stat()).isFile())
        return shadowFailure("storage_unavailable");
      const structure = await open(
        join(attempt, "structure.ndjson"),
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      handles.push(structure);
      if (!(await structure.stat()).isFile())
        return shadowFailure("storage_unavailable");
      const propertyFiles: FileHandle[] = [];
      for (const name of ["nodes.bin", "keys.utf16le", "properties.ndjson"]) {
        const handle = await open(
          join(attempt, name),
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        handles.push(handle);
        propertyFiles.push(handle);
        if (!(await handle.stat()).isFile())
          return shadowFailure("storage_unavailable");
      }
      const [nodes, keys, properties] = propertyFiles;
      if (nodes === undefined || keys === undefined || properties === undefined)
        return shadowFailure("storage_unavailable");
      // Both passes use explicit offsets on this verified descriptor, never a pathname reopen.
      const spool = await spoolInput(verified, {
        tokens: output,
        frames,
        structure,
        nodes,
        keys,
        properties,
      });
      if (spool._tag === "err") return spool;
      const verifiedAfter = await verified.stat();
      if (
        spool.value.spool.sourceHash !== copied.hash ||
        spool.value.spool.sourceBytes !== copied.bytes ||
        verifiedBefore.size !== verifiedAfter.size ||
        verifiedBefore.mtimeMs !== verifiedAfter.mtimeMs ||
        verifiedBefore.ctimeMs !== verifiedAfter.ctimeMs
      )
        return shadowFailure("backup_mismatch");
      const synced = await Promise.allSettled([
        output.sync(),
        frames.sync(),
        structure.sync(),
        nodes.sync(),
        keys.sync(),
        properties.sync(),
      ]);
      if (synced.some((result) => result.status === "rejected"))
        return shadowFailure("storage_unavailable");
      await syncDirectory(attempt);
      options.signal?.throwIfAborted();
      return ok({
        state: "properties_resolved",
        sourceHash: copied.hash,
        sourceBytes: copied.bytes,
        directory: attempt,
        spool: spool.value.spool,
        structure: spool.value.structure,
        properties: spool.value.properties,
        pending: "sensitive_scan_schema_conversion_equality",
      });
    } catch (cause: unknown) {
      if (options.signal?.aborted) return shadowFailure("cancelled");
      if (cause instanceof RangeError)
        return shadowFailure("representation_exhausted");
      return shadowFailure("storage_unavailable");
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    }
  }
}

async function copyAndHash(
  source: FileHandle,
  destination: FileHandle | undefined,
  signal: AbortSignal | undefined,
) {
  const buffer = Buffer.alloc(16384);
  const hash = createHash("sha256");
  let bytes = 0;
  for (;;) {
    signal?.throwIfAborted();
    const read = await source.read(buffer, 0, buffer.length, bytes);
    if (read.bytesRead === 0) break;
    const block = buffer.subarray(0, read.bytesRead);
    hash.update(block);
    if (destination !== undefined) await destination.writeFile(block);
    bytes += read.bytesRead;
    if (!Number.isSafeInteger(bytes))
      throw new RangeError("Legacy JSON byte count exhausted");
  }
  return { hash: hash.digest("hex"), bytes };
}

async function syncDirectory(directory: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      constants.O_DIRECTORY,
  );
  try {
    if (!(await handle.stat()).isDirectory())
      throw new Error("Unsafe migration directory");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function checkDirectoryChain(directory: string): Promise<void> {
  const parent = dirname(directory);
  if (parent !== directory) await checkDirectoryChain(parent);
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error("Unsafe migration directory");
}

async function createPrivateDirectoryChain(
  root: string,
  directory: string,
): Promise<void> {
  if (root === directory || !isPathContained(root, directory))
    throw new Error("Unsafe migration directory");
  let current = root;
  for (const segment of relative(root, directory).split("/")) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "EEXIST"
      )
        throw cause;
    }
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error("Unsafe migration directory");
    // An earlier failed sync can leave this entry present but not durable.
    await syncDirectory(dirname(current));
  }
}

function shadowFailure(
  reason: AnalysisShadowFailure["reason"],
): Result<never, AnalysisShadowFailure> {
  return err({ _tag: "AnalysisShadowFailure", reason });
}
