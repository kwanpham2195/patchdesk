import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
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
    return ok(JSON.parse(contents) as unknown);
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

  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true });
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${serialized}\n`, "utf8");
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

/** Append a safe JSON record; debug traces never replace source-of-truth JSON files. */
export async function appendJsonLine(
  path: string,
  value: unknown,
): Promise<Result<void, StorageFailure>> {
  if (containsSensitiveData(value)) {
    return err(storageFailure("append", "sensitive_value"));
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return err(storageFailure("append", "invalid_stored_value"));
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(path, "a", 0o600);
    await handle.writeFile(`${serialized}\n`, "utf8");
    await syncBestEffort(handle);
    await handle.close();
    return ok(undefined);
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    return err(storageFailure("append", "io"));
  }
}

function storageFailure(
  operation: StorageFailure["operation"],
  reason: StorageFailure["reason"],
): StorageFailure {
  return { _tag: "StorageFailure", operation, reason };
}

function isNotFound(cause: unknown): boolean {
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

function containsSensitiveData(value: unknown): boolean {
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
      /(?:token|secret|authorization|cookie|password)/i.test(key) ||
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
