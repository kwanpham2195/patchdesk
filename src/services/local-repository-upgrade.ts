import { KeyedMutex } from "#src/domain/keyed-mutex";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import {
  LocalRepositoryStore,
  type LocalRepositoryCatalog,
} from "#src/adapters/storage/local-repository-store";
import {
  containsSensitiveData,
  isNotFound,
  readJsonFile,
  writeAtomicFile,
  writeAtomicJson,
  type StorageFailure,
} from "#src/adapters/storage/json-file";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { CommandRunner } from "#src/adapters/github/command-runner";
import {
  parseAbsolutePath,
  parseContentHash,
  parseReviewId,
  parseWorkspaceProfileId,
  type ContentHash,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  parseLocalRepositoryId,
  sameRepositoryIdentityKey,
  type GitHubRepositoryKey,
  type LocalRepositoryRegistration,
} from "#src/domain/local-repository";
import { parseReview } from "#src/domain/review";
import {
  parsePreSchemaWorkspaceProfile,
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "#src/domain/workspace-profile";
import { err, ok, type Result } from "#src/domain/result";
import type { AppLogService } from "./app-log-service";

/** Runs before profile loading and recovery; catalog publication precedes profile activation. */
export class LocalRepositoryUpgrade {
  private static readonly locks = new KeyedMutex();
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly commands: CommandRunner,
    private readonly logs: Pick<AppLogService, "write">,
  ) {}

  async run(): Promise<Result<void, StorageFailure>> {
    const directory = join(this.paths.configDirectory(), "profiles");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (cause: unknown) {
      return isNotFound(cause) ? ok(undefined) : failure("io");
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const id = parseWorkspaceProfileId(name.slice(0, -5));
      if (id._tag === "err") return failure("invalid_stored_value");
      const result = await LocalRepositoryUpgrade.locks.run(
        this.paths.profileFile(id.value),
        () => this.upgrade(id.value),
      );
      if (result._tag === "err") return result;
    }
    return ok(undefined);
  }

  private async upgrade(
    profileId: WorkspaceProfileId,
  ): Promise<Result<void, StorageFailure>> {
    const lockDirectory = `${this.paths.profileFile(profileId)}.upgrade-locks`;
    const lock = join(lockDirectory, `${process.pid}-${randomUUID()}.json`);
    const published = await writeAtomicJson(lock, { pid: process.pid });
    if (published._tag === "err") return published;
    try {
      const exclusive = await checkUpgradeLockOwners(lockDirectory, lock);
      if (exclusive._tag === "err") {
        this.record(profileId, "upgrade_writer_exclusion_failed");
        return exclusive;
      }
      const result = await this.upgradeLocked(profileId);
      if (result._tag === "err")
        this.record(profileId, "upgrade_refused", result.error.reason);
      return result;
    } finally {
      try {
        await unlink(lock);
      } catch {
        this.record(profileId, "upgrade_lock_cleanup_failed");
      }
    }
  }

  private async upgradeLocked(
    profileId: WorkspaceProfileId,
  ): Promise<Result<void, StorageFailure>> {
    const raw = await readUpgradeInput(this.paths.profileFile(profileId));
    if (raw._tag === "err") return raw;
    const store = new LocalRepositoryStore(this.paths);
    const version = v.safeParse(
      v.object({ schemaVersion: v.optional(v.unknown()) }),
      raw.value.value,
    );
    if (!version.success) return failure("invalid_stored_value");
    if (version.output.schemaVersion !== undefined) {
      const profile = parseWorkspaceProfileConfig(raw.value.value);
      if (profile._tag === "err" || profile.value.id !== profileId)
        return failure("invalid_stored_value");
      const catalog = await store.load(profileId);
      if (catalog._tag === "err") return catalog;
      if (
        catalog.value.generationId !==
          profile.value.localRepositoryCatalogGeneration ||
        !watchReferencesValid(profile.value, catalog.value)
      )
        return failure("invalid_stored_value");
      return ok(undefined);
    }
    const profile = parsePreSchemaWorkspaceProfile(raw.value.value);
    if (profile._tag === "err" || profile.value.id !== profileId)
      return failure("invalid_stored_value");
    this.record(profileId, "upgrade_inventory_started");
    const inputs = await this.inventory(profile.value, raw.value.bytes);
    if (inputs._tag === "err") return inputs;
    const existing = await store.load(profileId);
    let catalog: LocalRepositoryCatalog;
    if (existing._tag === "ok") {
      catalog = existing.value;
      if (
        catalog.bootstrapInputFingerprint !== inputs.value.fingerprint ||
        catalog.repositories.length !== inputs.value.keys.length ||
        !inputs.value.keys.every((key) =>
          catalog.repositories.some((repository) =>
            sameRepositoryIdentityKey(repository.identityKey, key),
          ),
        )
      )
        return failure("invalid_stored_value");
      this.record(profileId, "upgrade_catalog_reused");
    } else {
      if (existing.error.reason !== "not_found") return existing;
      const repositories = await this.registrations(
        profile.value,
        inputs.value.keys,
      );
      if (repositories._tag === "err") return repositories;
      catalog = {
        format: 1,
        profileId,
        generationId: randomUUID(),
        revision: 1,
        repositories: repositories.value,
        bootstrapInputFingerprint: inputs.value.fingerprint,
      };
    }
    const backup = await this.backup(profileId, inputs.value.profileBytes);
    if (backup._tag === "err") return backup;
    if (existing._tag === "err") {
      const published = await store.save(catalog);
      if (published._tag === "err") return published;
      this.record(profileId, "upgrade_catalog_published");
    }
    const rechecked = await this.inventory(profile.value, raw.value.bytes);
    if (rechecked._tag === "err") return rechecked;
    if (rechecked.value.fingerprint !== catalog.bootstrapInputFingerprint)
      return failure("invalid_stored_value");
    const activated: WorkspaceProfileConfig = {
      ...profile.value,
      schemaVersion: 1,
      localRepositoryCatalogGeneration: catalog.generationId,
      repos: profile.value.repos.map((repo) => {
        const registration = catalog.repositories.find((entry) =>
          sameRepositoryIdentityKey(entry.identityKey, {
            kind: "github",
            host: repo.host,
            owner: repo.owner,
            repo: repo.repo,
          }),
        );
        return registration === undefined
          ? repo
          : { ...repo, localRepositoryId: registration.id };
      }),
    };
    const saved = await writeAtomicJson(
      this.paths.profileFile(profileId),
      activated,
    );
    if (saved._tag === "ok")
      this.record(profileId, "upgrade_profile_activated");
    return saved;
  }

  private async inventory(
    profile: Pick<WorkspaceProfileConfig, "id" | "repos">,
    expectedProfileBytes: string,
  ): Promise<
    Result<
      {
        readonly fingerprint: ContentHash;
        readonly profileBytes: string;
        readonly keys: ReadonlyArray<GitHubRepositoryKey>;
      },
      StorageFailure
    >
  > {
    const keys: GitHubRepositoryKey[] = [];
    const paths = new Map<string, string | undefined>();
    for (const repo of profile.repos) {
      const key: GitHubRepositoryKey = {
        kind: "github",
        host: repo.host,
        owner: repo.owner,
        repo: repo.repo,
      };
      const exact = JSON.stringify([key.host, key.owner, key.repo]);
      if (paths.has(exact) && paths.get(exact) !== repo.localPath)
        return failure("invalid_stored_value");
      paths.set(exact, repo.localPath);
      if (
        repo.localPath !== undefined &&
        !keys.some((previous) => sameRepositoryIdentityKey(previous, key))
      )
        keys.push(key);
    }
    try {
      const profileInput = await readUpgradeInput(
        this.paths.profileFile(profile.id),
      );
      if (profileInput._tag === "err") return profileInput;
      const profileBytes = profileInput.value.bytes;
      if (profileBytes !== expectedProfileBytes)
        return failure("invalid_stored_value");
      const digest = createHash("sha256").update(
        JSON.stringify(["local-repository-bootstrap/1", profileBytes]),
      );
      let names: string[];
      try {
        names = await readdir(
          this.paths.profileWorkbenchesDirectory(profile.id),
        );
      } catch (cause: unknown) {
        if (!isNotFound(cause)) return failure("io");
        names = [];
      }
      for (const name of names.sort()) {
        if (name === ".quarantine") continue;
        const id = parseReviewId(name);
        if (id._tag === "err") return failure("invalid_stored_value");
        const file = this.paths.reviewFile(profile.id, id.value);
        const raw = await readUpgradeInput(file);
        if (raw._tag === "err") return raw;
        const review = parseReview(raw.value.value);
        if (
          review._tag === "err" ||
          review.value.id !== id.value ||
          review.value.identity.profileId !== profile.id ||
          review.value.schemaVersion !== 2 ||
          review.value.identity.identityKey.kind !== "github"
        )
          return failure("invalid_stored_value");
        digest.update(JSON.stringify([name, raw.value.bytes]));
        if (review.value.identity.source.kind === "pull_request") continue;
        const key = review.value.identity.identityKey;
        if (!keys.some((previous) => sameRepositoryIdentityKey(previous, key)))
          keys.push(key);
      }
      const fingerprint = parseContentHash(digest.digest("hex"));
      return fingerprint._tag === "err"
        ? failure("invalid_stored_value")
        : ok({ fingerprint: fingerprint.value, profileBytes, keys });
    } catch {
      return failure("io");
    }
  }

  private async registrations(
    profile: Pick<WorkspaceProfileConfig, "repos">,
    keys: ReadonlyArray<GitHubRepositoryKey>,
  ): Promise<
    Result<ReadonlyArray<LocalRepositoryRegistration>, StorageFailure>
  > {
    const repositories: LocalRepositoryRegistration[] = [];
    for (const key of keys) {
      const id = parseLocalRepositoryId(randomUUID());
      if (id._tag === "err") return failure("invalid_stored_value");
      const base = {
        id: id.value,
        identityKey: key,
        displayName: `${key.owner}/${key.repo}`,
      };
      const watched = profile.repos.find(
        (repo) =>
          repo.host === key.host &&
          repo.owner === key.owner &&
          repo.repo === key.repo,
      );
      if (watched?.localPath === undefined) {
        repositories.push({ ...base, state: "unresolved" });
        continue;
      }
      const root = watched.localPath;
      const resolved = await this.commands.runText({
        argv: [
          "git",
          "rev-parse",
          "--show-toplevel",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        cwd: root,
        timeoutMs: 5_000,
      });
      if (resolved._tag === "err") {
        repositories.push({ ...base, state: "missing", configuredRoot: root });
        continue;
      }
      const [topLevel, commonDir, ...extra] = resolved.value.trim().split("\n");
      if (
        topLevel === undefined ||
        commonDir === undefined ||
        extra.length !== 0
      ) {
        repositories.push({
          ...base,
          state: "unresolved",
          configuredRoot: root,
        });
        continue;
      }
      try {
        const canonicalRoot = parseAbsolutePath(await realpath(topLevel));
        const common = parseAbsolutePath(await realpath(commonDir));
        if (canonicalRoot._tag === "err" || common._tag === "err")
          return failure("invalid_stored_value");
        repositories.push({
          ...base,
          state: "resolved",
          configuredRoot: root,
          canonicalCommonDirectory: common.value,
        });
      } catch {
        repositories.push({ ...base, state: "missing", configuredRoot: root });
      }
    }
    return ok(
      repositories.map((repo) =>
        repo.canonicalCommonDirectory !== undefined &&
        repositories.some(
          (other) =>
            other.id !== repo.id &&
            other.canonicalCommonDirectory === repo.canonicalCommonDirectory,
        )
          ? { ...repo, state: "unresolved" }
          : repo,
      ),
    );
  }

  private async backup(
    profileId: WorkspaceProfileId,
    bytes: string,
  ): Promise<Result<void, StorageFailure>> {
    const path = this.paths.preUpgradeProfileFile(profileId);
    try {
      return (await readFile(path)).equals(Buffer.from(bytes, "utf8"))
        ? ok(undefined)
        : failure("invalid_stored_value");
    } catch (cause: unknown) {
      return isNotFound(cause) ? writeAtomicFile(path, bytes) : failure("io");
    }
  }

  private record(
    profileId: WorkspaceProfileId,
    reason:
      | "upgrade_inventory_started"
      | "upgrade_catalog_reused"
      | "upgrade_catalog_published"
      | "upgrade_profile_activated"
      | "upgrade_refused"
      | "upgrade_writer_exclusion_failed"
      | "upgrade_lock_cleanup_failed",
    failureReason?: StorageFailure["reason"],
  ): void {
    try {
      this.logs.write({
        process: "main",
        level: reason === "upgrade_refused" ? "error" : "info",
        topic: "local-repository-upgrade",
        message: reason,
        profileId,
        meta: { reason, failureReason },
      });
    } catch {
      /* Diagnostics cannot change activation outcomes. */
    }
  }
}

function watchReferencesValid(
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

function failure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason });
}

/** Published contender files avoid reclaiming another writer's lock after a stale-owner race. */
async function checkUpgradeLockOwners(
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
async function readUpgradeInput(
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
