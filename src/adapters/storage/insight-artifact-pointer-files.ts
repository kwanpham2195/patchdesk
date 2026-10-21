import type { Stats } from "node:fs";
import { mkdir, realpath, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { err, ok, type Result } from "#src/domain/result";
import {
  MAX_INSIGHT_OBJECT_BYTES,
  readBoundedInsightArtifactFile,
  readOwnedParents,
  removeStagedTemporaryFile,
  sameParents,
  stageOwnedTemporaryFile,
  syncOwnedDirectory,
} from "./insight-artifact-files";
import { containsSensitiveValue, type StorageFailure } from "./json-file";
import { isPathContained } from "./path-containment";

/**
 * committed: the replacement is durable. conflict: the target differed from the expected bytes and nothing was written.
 * unknown: the rename or the directory fsync failed after the rename began; the caller then calls
 * `reconcileInsightPointerFile` under the same lock and treats anything but a durable replacement as not committed
 * or a storage failure.
 */
type InsightPointerReplacement = {
  readonly _tag: "committed" | "conflict" | "unknown";
};

type InsightPointerReconciliation = {
  readonly _tag: "committed" | "not_committed";
};

/**
 * committed, conflict: as for `replaceInsightPointerFile`. not_committed: an uncertain replacement was reconciled as
 * absent. unknown: reconciliation itself failed, so the replacement may be durable; the caller rereads under the same
 * lock before acting and never retries blindly.
 */
type InsightPointerCommit = {
  readonly _tag: "committed" | "conflict" | "not_committed" | "unknown";
};

/** Replaces the pointer, then reconciles an uncertain replacement under the caller's lock; there is no retry. */
export async function commitInsightPointerFile(
  ownedRoot: string,
  path: string,
  expected: Uint8Array | null,
  replacement: Uint8Array,
): Promise<Result<InsightPointerCommit, StorageFailure>> {
  const replaced = await replaceInsightPointerFile(
    ownedRoot,
    path,
    expected,
    replacement,
  );
  if (replaced._tag === "err" || replaced.value._tag !== "unknown")
    return replaced;
  const reconciled = await reconcileInsightPointerFile(
    ownedRoot,
    path,
    expected,
    replacement,
  );
  // A failed reconciliation leaves the outcome unknown; it must not read as a definite failure.
  return reconciled._tag === "err" ? ok({ _tag: "unknown" }) : reconciled;
}

/**
 * Replaces one small mutable pointer file when it still holds `expected` (null: absent). The compare and the rename
 * are atomic only while the caller holds the lock that serializes every writer of this path. Failures before the
 * rename leave the target untouched and return a StorageFailure; there is no retry.
 */
export async function replaceInsightPointerFile(
  ownedRoot: string,
  path: string,
  expected: Uint8Array | null,
  replacement: Uint8Array,
): Promise<Result<InsightPointerReplacement, StorageFailure>> {
  const directory = pointerDirectory(ownedRoot, path);
  if (
    directory === undefined ||
    replacement.length === 0 ||
    replacement.length > MAX_INSIGHT_OBJECT_BYTES ||
    (expected !== null && expected.length > MAX_INSIGHT_OBJECT_BYTES)
  )
    return pointerFailure("write", "invalid_stored_value");
  const refusal = refusePointerBytes(replacement);
  if (refusal !== undefined) return refusal;
  const parents = await prepareParents(ownedRoot, directory, path);
  if (parents._tag === "err") return parents;
  const staged = await stageOwnedTemporaryFile(
    ownedRoot,
    path,
    replacement,
    parents.value,
  );
  if (staged._tag === "err") return staged;
  let renaming = false;
  let outcome: Result<InsightPointerReplacement, StorageFailure>;
  try {
    const current = await readBoundedInsightArtifactFile(ownedRoot, path);
    if (current._tag === "err" && current.error.reason !== "not_found")
      outcome = pointerFailure("write", current.error.reason);
    else if (
      expected === null
        ? current._tag === "ok"
        : current._tag === "err" || !Buffer.from(current.value).equals(expected)
    )
      outcome = ok({ _tag: "conflict" });
    else if (!(await parentsUnchanged(ownedRoot, path, parents.value)))
      outcome = pointerFailure("write", "io");
    else {
      renaming = true;
      await rename(staged.value.path, path);
      const synced = await syncOwnedDirectory(directory);
      outcome = ok({ _tag: synced._tag === "ok" ? "committed" : "unknown" });
    }
  } catch {
    outcome = renaming
      ? ok({ _tag: "unknown" })
      : pointerFailure("write", "io");
  }
  const removed = await removeStagedTemporaryFile(
    ownedRoot,
    path,
    staged.value,
    parents.value,
    true,
  );
  // After the rename started the outcome is already decided; cleanup cannot change it.
  return renaming || removed._tag === "ok" ? outcome : removed;
}

/**
 * Rereads the pointer after an `unknown` replacement, under the same lock. The replacement counts as committed only
 * after a fresh directory fsync succeeds; the prior bytes (or absence) mean it was not committed; anything else is
 * a storage failure.
 */
async function reconcileInsightPointerFile(
  ownedRoot: string,
  path: string,
  expectedPrior: Uint8Array | null,
  replacement: Uint8Array,
): Promise<Result<InsightPointerReconciliation, StorageFailure>> {
  const directory = pointerDirectory(ownedRoot, path);
  if (directory === undefined)
    return pointerFailure("read", "invalid_stored_value");
  const current = await readBoundedInsightArtifactFile(ownedRoot, path);
  if (current._tag === "err") {
    if (current.error.reason !== "not_found") return current;
    return expectedPrior === null
      ? ok({ _tag: "not_committed" })
      : pointerFailure("read", "invalid_stored_value");
  }
  if (Buffer.from(current.value).equals(replacement)) {
    try {
      const synced = await syncOwnedDirectory(directory);
      return synced._tag === "ok" ? ok({ _tag: "committed" }) : synced;
    } catch {
      return pointerFailure("write", "io");
    }
  }
  return expectedPrior !== null &&
    Buffer.from(current.value).equals(expectedPrior)
    ? ok({ _tag: "not_committed" })
    : pointerFailure("read", "invalid_stored_value");
}

async function parentsUnchanged(
  ownedRoot: string,
  path: string,
  parents: ReadonlyArray<Stats>,
): Promise<boolean> {
  const checked = await readOwnedParents(ownedRoot, path);
  return checked._tag === "ok" && sameParents(parents, checked.value);
}

/** Pointers live only in the Review's named pointer directories; Guide progress filenames bind a result digest. */
function pointerDirectory(ownedRoot: string, path: string): string | undefined {
  const directory = dirname(resolve(path));
  return basename(dirname(directory)) === "insight-artifacts-v2" &&
    (basename(directory) === "slots" ||
      basename(directory) === "journals" ||
      (basename(directory) === "guide-progress" &&
        /^[a-f0-9]{64}\.json$/.test(basename(path)))) &&
    isPathContained(ownedRoot, directory)
    ? directory
    : undefined;
}

function refusePointerBytes(
  bytes: Uint8Array,
): Result<never, StorageFailure> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    return pointerFailure("write", "invalid_stored_value");
  }
  return containsSensitiveValue(parsed)
    ? pointerFailure("write", "sensitive_value")
    : undefined;
}

/** Checks the existing ancestors before creating the pointer directory, then syncs its parent even when it already existed. */
async function prepareParents(
  ownedRoot: string,
  directory: string,
  path: string,
): Promise<Result<ReadonlyArray<Stats>, StorageFailure>> {
  try {
    const ancestors = await readOwnedParents(ownedRoot, directory);
    if (ancestors._tag === "err")
      return pointerFailure(
        "write",
        ancestors.error.reason === "not_found" ? "io" : ancestors.error.reason,
      );
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "EEXIST")
      )
        return pointerFailure("write", "io");
    }
    const parents = await readOwnedParents(ownedRoot, path);
    if (parents._tag === "err")
      return pointerFailure(
        "write",
        parents.error.reason === "not_found" ? "io" : parents.error.reason,
      );
    if (
      !sameParents(
        ancestors.value,
        parents.value.slice(0, ancestors.value.length),
      ) ||
      !isPathContained(await realpath(ownedRoot), await realpath(directory))
    )
      return pointerFailure("write", "invalid_stored_value");
    // A directory entry created by another writer or an earlier failed call may not be durable yet.
    const synced = await syncOwnedDirectory(dirname(directory));
    return synced._tag === "err" ? synced : parents;
  } catch {
    return pointerFailure("write", "io");
  }
}

function pointerFailure(
  operation: "read" | "write",
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation, reason });
}
