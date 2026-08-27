import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { err, ok, type Result } from "../../domain/result";

export type StorageFailure = {
  readonly _tag: "StorageFailure";
  readonly operation: "read" | "write" | "append";
  readonly reason:
    | "not_found"
    | "invalid_json"
    | "invalid_stored_value"
    | "sensitive_value"
    | "io";
};

/** Read one JSON value while keeping corrupt contents out of diagnostics. */
export async function readJsonFile(
  path: string,
): Promise<Result<unknown, StorageFailure>> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause: unknown) {
    return err(storageFailure("read", isNotFound(cause) ? "not_found" : "io"));
  }

  try {
    const parsed: unknown = JSON.parse(contents);
    if (containsSensitiveData(parsed)) {
      return err(storageFailure("read", "sensitive_value"));
    }
    return ok(parsed);
  } catch {
    return err(storageFailure("read", "invalid_json"));
  }
}

/** Persist one JSON value with temp-file fsync and atomic replacement. */
export async function writeAtomicJson(
  path: string,
  value: unknown,
): Promise<Result<void, StorageFailure>> {
  if (containsSensitiveData(value)) {
    return err(storageFailure("write", "sensitive_value"));
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return err(storageFailure("write", "invalid_stored_value"));
  }

  return writeAtomicFile(path, `${serialized}\n`);
}

/**
 * Persist raw contents to `path` through the same temp-file, fsync, rename,
 * directory-fsync sequence every Patchdesk artifact write uses (per
 * `docs/architecture.md`'s "Writes are atomic" promise): write to a
 * sibling `.tmp` file, fsync the handle, rename it over the target, then
 * best-effort fsync the containing directory so the rename itself survives
 * a crash. The temp file is removed on any failure so a partial write never
 * shows up as a stray sibling of `path`.
 */
export async function writeAtomicFile(
  path: string,
  contents: Uint8Array | string,
): Promise<Result<void, StorageFailure>> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    handle = await open(temporaryPath, "wx", 0o600);
    if (typeof contents === "string") {
      await handle.writeFile(contents, "utf8");
    } else {
      await handle.writeFile(contents);
    }
    await syncBestEffort(handle);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectoryBestEffort(directory);
    return ok(undefined);
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return err(storageFailure("write", "io"));
  }
}
function storageFailure(
  operation: StorageFailure["operation"],
  reason: StorageFailure["reason"],
): StorageFailure {
  return { _tag: "StorageFailure", operation, reason };
}

/**
 * The one `ENOENT` predicate for every caught filesystem rejection: "this
 * path is simply not there", as opposed to a real I/O failure. It reads
 * `code` off any object rather than requiring `instanceof Error`, so a
 * `node:fs` rejection that crossed a realm boundary (an Electron utility
 * process, a worker thread, a `vm` context) is still recognised as missing
 * instead of being reported as an I/O error.
 */
export function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

async function syncBestEffort(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  await handle.sync().catch(() => undefined);
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) {
    return;
  }

  await handle.sync().catch(() => undefined);
  await handle.close().catch(() => undefined);
}

/** Detect credential-like values before any Patchdesk artifact is persisted. */
export function containsSensitiveData(value: unknown): boolean {
  if (typeof value === "string") {
    return containsCredentialLikeValue(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsSensitiveData);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      // Opaque, one-way finding tokens are deliberate persisted review evidence;
      // credential-shaped values are still rejected by the value scan below.
      /(?:secret|authorization|cookie|password)/i.test(key) ||
      containsSensitiveData(nestedValue)
    ) {
      return true;
    }
  }
  return false;
}

function containsCredentialLikeValue(value: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|\bBearer\s+[A-Za-z0-9._~-]{16,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/.test(
    value,
  );
}
