import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import { err, ok, type Result } from "#src/domain/result";
import { readOwnedParents, sameParents } from "./insight-artifact-files";
import {
  patchCaptureFailure,
  type InsightPatchCaptureInput,
  type InsightPatchFailure,
} from "./insight-artifact-job-protocol";
import { InsightSensitiveStream } from "./insight-sensitive-stream";
import { isPathContained } from "./path-containment";
import type { StorageFailure } from "./json-file";

const chunkBytes = 16 * 1024;

/** Owns an unlinked private snapshot handle; only fully scanned, hash-matched snapshots can be constructed. */
export class InsightCaptureSourceFile {
  private offset = 0;
  private constructor(
    private readonly file: FileHandle,
    readonly bytes: number,
    readonly utf16Units: number,
  ) {}

  /** Copies and scans the real source before any immutable install; the snapshot has no reopenable pathname. */
  static async capture(
    input: InsightPatchCaptureInput,
    options: { readonly signal?: AbortSignal; readonly maxBytes?: number },
  ): Promise<Result<InsightCaptureSourceFile, InsightPatchFailure>> {
    let source: FileHandle | undefined;
    let snapshot: FileHandle | undefined;
    let temporary: string | undefined;
    let identity: Stats | undefined;
    try {
      if (options.signal?.aborted) return patchCaptureFailure("aborted");
      const parents = await readOwnedParents(
        input.sourceRoot,
        input.sourcePath,
      );
      const outputParents = await readOwnedParents(
        input.destinationRoot,
        join(input.destinationReview, ".snapshot-check"),
      );
      if (parents._tag === "err" || outputParents._tag === "err")
        return patchCaptureFailure("invalid_source");
      if (
        !isPathContained(
          await realpath(input.sourceRoot),
          await realpath(input.sourcePath),
        ) ||
        isPathContained(
          await realpath(input.sourceRoot),
          await realpath(input.destinationRoot),
        ) ||
        isPathContained(
          await realpath(input.destinationRoot),
          await realpath(input.sourceRoot),
        )
      )
        return patchCaptureFailure("invalid_source");
      const before = await lstat(input.sourcePath);
      source = await open(
        input.sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = await source.stat();
      if (!ownedFile(before) || !sameFile(before, opened))
        return patchCaptureFailure("invalid_source");
      // Refuse before copying; the loop below still bounds a source that grows while it is read.
      if (options.maxBytes !== undefined && opened.size > options.maxBytes)
        return patchCaptureFailure("too_large");
      temporary = join(
        input.destinationReview,
        `.patch-snapshot-${randomUUID()}.tmp`,
      );
      snapshot = await open(
        temporary,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      identity = await snapshot.stat();
      if (!ownedFile(identity) || !sameFile(identity, await lstat(temporary)))
        return patchCaptureFailure("invalid_source");
      // Unlink before writing prose, so no second path can reopen or replace validated bytes.
      await unlink(temporary);
      temporary = undefined;
      const scan = new InsightSensitiveStream();
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(chunkBytes);
      let bytes = 0;
      let utf16Units = 0;
      for (;;) {
        if (options.signal?.aborted) return patchCaptureFailure("aborted");
        const read = await source.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        const raw = buffer.subarray(0, read.bytesRead);
        let text: string;
        try {
          text = decoder.decode(raw, { stream: true });
        } catch {
          return patchCaptureFailure("invalid_source");
        }
        if (scan.push(text)) return patchCaptureFailure("sensitive_value");
        const nextBytes = bytes + raw.length;
        const nextUnits = utf16Units + text.length;
        if (options.maxBytes !== undefined && nextBytes > options.maxBytes)
          return patchCaptureFailure("too_large");
        if (
          !Number.isSafeInteger(nextBytes) ||
          !Number.isSafeInteger(nextUnits)
        )
          return patchCaptureFailure("invalid_source");
        await snapshot.writeFile(raw);
        hash.update(raw);
        bytes = nextBytes;
        utf16Units = nextUnits;
      }
      let final: string;
      try {
        final = decoder.decode();
      } catch {
        return patchCaptureFailure("invalid_source");
      }
      if (scan.push(final) || scan.finish())
        return patchCaptureFailure("sensitive_value");
      utf16Units += final.length;
      if (!Number.isSafeInteger(utf16Units))
        return patchCaptureFailure("invalid_source");
      if (
        hash.digest("hex") !== input.expectedHash ||
        !sameFile(opened, await source.stat()) ||
        !sameFile(opened, await lstat(input.sourcePath))
      )
        return patchCaptureFailure("stale_source");
      const afterParents = await readOwnedParents(
        input.sourceRoot,
        input.sourcePath,
      );
      const afterOutput = await readOwnedParents(
        input.destinationRoot,
        join(input.destinationReview, ".snapshot-check"),
      );
      if (
        afterParents._tag === "err" ||
        afterOutput._tag === "err" ||
        !sameParents(parents.value, afterParents.value) ||
        !sameParents(outputParents.value, afterOutput.value)
      )
        return patchCaptureFailure("invalid_source");
      if ((await snapshot.stat()).size !== bytes)
        return patchCaptureFailure("io");
      if (options.signal?.aborted) return patchCaptureFailure("aborted");
      const result = new InsightCaptureSourceFile(snapshot, bytes, utf16Units);
      snapshot = undefined;
      return ok(result);
    } catch {
      return patchCaptureFailure(options.signal?.aborted ? "aborted" : "io");
    } finally {
      await source?.close().catch(() => undefined);
      await snapshot?.close().catch(() => undefined);
      if (temporary !== undefined && identity !== undefined) {
        const current = await lstat(temporary).catch(() => undefined);
        if (current?.dev === identity.dev && current.ino === identity.ino)
          await unlink(temporary).catch(() => undefined);
      }
    }
  }

  /** Reads bounded snapshot bytes at explicit offsets; the writable handle never escapes this owner. */
  async read(): Promise<Result<Uint8Array | undefined, StorageFailure>> {
    try {
      const buffer = Buffer.alloc(chunkBytes);
      const read = await this.file.read(buffer, 0, buffer.length, this.offset);
      this.offset += read.bytesRead;
      return ok(
        read.bytesRead === 0 ? undefined : buffer.subarray(0, read.bytesRead),
      );
    } catch {
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
  }

  /** The whole scanned snapshot as text; the caller bounds `bytes` through `capture`'s `maxBytes` before holding it. */
  async readAll(): Promise<Result<string, StorageFailure>> {
    try {
      const buffer = Buffer.alloc(this.bytes);
      let filled = 0;
      while (filled < buffer.length) {
        const read = await this.file.read(
          buffer,
          filled,
          buffer.length - filled,
          filled,
        );
        if (read.bytesRead === 0)
          return err({
            _tag: "StorageFailure",
            operation: "read",
            reason: "invalid_stored_value",
          });
        filled += read.bytesRead;
      }
      return ok(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer,
        ),
      );
    } catch {
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
  }

  /** Closes the sole snapshot handle after success, cancellation or failure. */
  async close(): Promise<Result<void, InsightPatchFailure>> {
    try {
      await this.file.close();
      return ok(undefined);
    } catch {
      return patchCaptureFailure("io");
    }
  }
}

function ownedFile(stat: Stats): boolean {
  return (
    stat.isFile() &&
    stat.uid === process.geteuid?.() &&
    (stat.mode & 0o022) === 0
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    ownedFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
