import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import type { LocalRepositoryCatalog } from "#src/adapters/storage/local-repository-store";
import {
  containsSensitiveData,
  isNotFound,
  readJsonFile,
  type StorageFailure,
} from "#src/adapters/storage/json-file";
import { sameRepositoryIdentityKey } from "#src/domain/local-repository";
import { err, ok, type Result } from "#src/domain/result";
import type { WorkspaceProfileConfig } from "#src/domain/workspace-profile";

export function watchReferencesValid(
  profile: WorkspaceProfileConfig,
  catalog: LocalRepositoryCatalog,
): boolean {
  return profile.repos.every(
    (repo) =>
      repo.localRepositoryId === undefined ||
      catalog.repositories.some(
        (entry) =>
          entry.id === repo.localRepositoryId &&
          sameRepositoryIdentityKey(entry.identityKey, {
            kind: "github",
            host: repo.host,
            owner: repo.owner,
            repo: repo.repo,
          }),
      ),
  );
}

export function failure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason });
}

/** Published contender files avoid reclaiming another writer's lock after a stale-owner race. */
export async function checkUpgradeLockOwners(
  directory: string,
  own: string,
): Promise<Result<void, StorageFailure>> {
  try {
    const names = await readdir(directory);
    for (const name of names) {
      if (!name.endsWith(".json") || join(directory, name) === own) continue;
      const owner = await readJsonFile(join(directory, name));
      if (owner._tag === "err") {
        if (owner.error.reason === "not_found") continue;
        return owner;
      }
      const pid = v.safeParse(
        v.strictObject({
          pid: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        }),
        owner.value,
      );
      if (!pid.success) return failure("invalid_stored_value");
      try {
        process.kill(pid.output.pid, 0);
        return failure("io");
      } catch (cause: unknown) {
        if (!v.safeParse(v.object({ code: v.literal("ESRCH") }), cause).success)
          return failure("io");
      }
    }
    return ok(undefined);
  } catch {
    return failure("io");
  }
}

/** Fingerprinting and validation use the same read, so a concurrent replacement cannot mix versions. */
export async function readUpgradeInput(
  path: string,
): Promise<
  Result<{ readonly bytes: string; readonly value: unknown }, StorageFailure>
> {
  try {
    const encoded = await readFile(path);
    const bytes = encoded.toString("utf8");
    if (!Buffer.from(bytes, "utf8").equals(encoded))
      return failure("invalid_json");
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      return failure("invalid_json");
    }
    return containsSensitiveData(value)
      ? failure("sensitive_value")
      : ok({ bytes, value });
  } catch (cause: unknown) {
    return failure(isNotFound(cause) ? "not_found" : "io");
  }
}
