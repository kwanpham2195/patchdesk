import { KeyedMutex } from "#src/domain/keyed-mutex";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import * as v from "valibot";
import {
  LocalRepositoryStore,
  type LocalRepositoryCatalog,
} from "#src/adapters/storage/local-repository-store";
import {
  isNotFound,
  writeAtomicFile,
  writeAtomicJson,
  type StorageFailure,
} from "#src/adapters/storage/json-file";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { CommandRunner } from "#src/adapters/github/command-runner";
import {
  parseContentHash,
  parseReviewId,
  parseWorkspaceProfileId,
  type ContentHash,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  sameRepositoryIdentityKey,
  type GitHubRepositoryKey,
} from "#src/domain/local-repository";
import { parseReview } from "#src/domain/review";
import {
  parsePreSchemaWorkspaceProfile,
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "#src/domain/workspace-profile";
import { err, ok, type Result } from "#src/domain/result";
import { definedProps } from "#src/domain/defined-props";
import { isPathContained } from "#src/adapters/storage/path-containment";
import type { AppLogService } from "./app-log-service";
import {
  checkUpgradeLockOwners,
  failure,
  readUpgradeInput,
  watchReferencesValid,
} from "./local-repository-upgrade-files";
import {
  refusal,
  type Refusal,
  type UpgradeRefusal,
  type UpgradeRefusalFile,
} from "./local-repository-upgrade-refusal";
import { resolveRegistrations } from "./local-repository-upgrade-registrations";

/** Runs before profile loading and recovery; catalog publication precedes profile activation. */
export class LocalRepositoryUpgrade {
  private static readonly locks = new KeyedMutex();
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly commands: CommandRunner,
    private readonly logs: Pick<AppLogService, "write">,
  ) {}

  async run(): Promise<Result<void, UpgradeRefusal>> {
    const directory = join(this.paths.configDirectory(), "profiles");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (cause: unknown) {
      return isNotFound(cause)
        ? ok(undefined)
        : this.refused(undefined, {
            reason: "storage_unavailable",
            storageReason: "io",
            file: directory,
          });
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const id = parseWorkspaceProfileId(name.slice(0, -5));
      if (id._tag === "err")
        return this.refused(undefined, {
          reason: "profile_unreadable",
          storageReason: "invalid_stored_value",
          file: join(directory, name),
        });
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
  ): Promise<Result<void, UpgradeRefusal>> {
    const lockDirectory = `${this.paths.profileFile(profileId)}.upgrade-locks`;
    const lock = join(lockDirectory, `${process.pid}-${randomUUID()}.json`);
    const published = await writeAtomicJson(lock, { pid: process.pid });
    if (published._tag === "err")
      return this.refused(profileId, {
        reason: "storage_unavailable",
        storageReason: published.error.reason,
        file: lockDirectory,
      });
    try {
      const exclusive = await checkUpgradeLockOwners(lockDirectory, lock);
      if (exclusive._tag === "err") {
        this.record(profileId, "upgrade_writer_exclusion_failed");
        return this.refused(profileId, {
          reason: "upgrade_locked",
          storageReason: exclusive.error.reason,
          file: lockDirectory,
        });
      }
      const result = await this.upgradeLocked(profileId);
      return result._tag === "err"
        ? this.refused(profileId, result.error)
        : result;
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
  ): Promise<Result<void, Refusal>> {
    const profileFile = this.paths.profileFile(profileId);
    const catalogFile = this.paths.localRepositoryCatalogFile(profileId);
    const unreadableProfile = (
      storageReason: StorageFailure["reason"] = "invalid_stored_value",
    ) =>
      refusal({
        reason: "profile_unreadable",
        storageReason,
        file: profileFile,
      });
    const raw = await readUpgradeInput(profileFile);
    if (raw._tag === "err") return unreadableProfile(raw.error.reason);
    const store = new LocalRepositoryStore(this.paths);
    const version = v.safeParse(
      v.object({ schemaVersion: v.optional(v.unknown()) }),
      raw.value.value,
    );
    if (!version.success) return unreadableProfile();
    if (version.output.schemaVersion !== undefined) {
      const profile = parseWorkspaceProfileConfig(raw.value.value);
      if (profile._tag === "err" || profile.value.id !== profileId)
        return unreadableProfile();
      const catalog = await store.load(profileId);
      if (catalog._tag === "err")
        return refusal({
          reason: "catalog_damaged",
          storageReason: catalog.error.reason,
          file: catalogFile,
        });
      if (
        catalog.value.generationId !==
          profile.value.localRepositoryCatalogGeneration ||
        !watchReferencesValid(profile.value, catalog.value)
      )
        return refusal({
          reason: "catalog_mismatch",
          storageReason: "invalid_stored_value",
          file: catalogFile,
        });
      return ok(undefined);
    }
    const profile = parsePreSchemaWorkspaceProfile(raw.value.value);
    if (profile._tag === "err" || profile.value.id !== profileId)
      return unreadableProfile();
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
        return refusal({
          reason: "catalog_mismatch",
          storageReason: "invalid_stored_value",
          file: catalogFile,
        });
      this.record(profileId, "upgrade_catalog_reused");
    } else {
      if (existing.error.reason !== "not_found")
        return refusal({
          reason: "catalog_damaged",
          storageReason: existing.error.reason,
          file: catalogFile,
        });
      const repositories = await resolveRegistrations(
        this.commands,
        profileFile,
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
    const backupFile = this.paths.preUpgradeProfileFile(profileId);
    const backup = await this.backup(profileId, inputs.value.profileBytes);
    if (backup._tag === "err")
      return refusal({
        reason:
          backup.error.reason === "invalid_stored_value"
            ? "backup_conflict"
            : "storage_unavailable",
        storageReason: backup.error.reason,
        file: backupFile,
      });
    if (existing._tag === "err") {
      const published = await store.save(catalog);
      if (published._tag === "err")
        return refusal({
          reason: "storage_unavailable",
          storageReason: published.error.reason,
          file: catalogFile,
          backup: backupFile,
        });
      this.record(profileId, "upgrade_catalog_published");
    }
    const rechecked = await this.inventory(profile.value, raw.value.bytes);
    if (rechecked._tag === "err")
      return err({ ...rechecked.error, backup: backupFile });
    if (rechecked.value.fingerprint !== catalog.bootstrapInputFingerprint)
      return refusal({
        reason: "inputs_changed",
        storageReason: "invalid_stored_value",
        file: profileFile,
        backup: backupFile,
      });
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
    const saved = await writeAtomicJson(profileFile, activated);
    if (saved._tag === "err")
      return refusal({
        reason: "storage_unavailable",
        storageReason: saved.error.reason,
        file: profileFile,
        backup: backupFile,
      });
    this.record(profileId, "upgrade_profile_activated");
    return ok(undefined);
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
      Refusal
    >
  > {
    const profileFile = this.paths.profileFile(profile.id);
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
        return refusal({
          reason: "conflicting_registrations",
          storageReason: "invalid_stored_value",
          file: profileFile,
        });
      paths.set(exact, repo.localPath);
      if (
        repo.localPath !== undefined &&
        !keys.some((previous) => sameRepositoryIdentityKey(previous, key))
      )
        keys.push(key);
    }
    try {
      const profileInput = await readUpgradeInput(profileFile);
      if (profileInput._tag === "err")
        return refusal({
          reason: "profile_unreadable",
          storageReason: profileInput.error.reason,
          file: profileFile,
        });
      const profileBytes = profileInput.value.bytes;
      if (profileBytes !== expectedProfileBytes)
        return refusal({
          reason: "inputs_changed",
          storageReason: "invalid_stored_value",
          file: profileFile,
        });
      const digest = createHash("sha256").update(
        JSON.stringify(["local-repository-bootstrap/1", profileBytes]),
      );
      const workbenches = this.paths.profileWorkbenchesDirectory(profile.id);
      let names: string[];
      try {
        names = await readdir(workbenches);
      } catch (cause: unknown) {
        if (!isNotFound(cause))
          return refusal({
            reason: "storage_unavailable",
            storageReason: "io",
            file: workbenches,
          });
        names = [];
      }
      for (const name of names.sort()) {
        if (name === ".quarantine") continue;
        const id = parseReviewId(name);
        if (id._tag === "err")
          return refusal({
            reason: "review_unreadable",
            storageReason: "invalid_stored_value",
            file: join(workbenches, name),
          });
        const file = this.paths.reviewFile(profile.id, id.value);
        const raw = await readUpgradeInput(file);
        if (raw._tag === "err")
          return refusal({
            reason: "review_unreadable",
            storageReason: raw.error.reason,
            file,
          });
        const review = parseReview(raw.value.value);
        if (
          review._tag === "err" ||
          review.value.id !== id.value ||
          review.value.identity.profileId !== profile.id ||
          review.value.schemaVersion !== 2 ||
          review.value.identity.identityKey.kind !== "github"
        )
          return refusal({
            reason: "review_unreadable",
            storageReason: "invalid_stored_value",
            file,
          });
        digest.update(JSON.stringify([name, raw.value.bytes]));
        if (review.value.identity.source.kind === "pull_request") continue;
        const key = review.value.identity.identityKey;
        if (!keys.some((previous) => sameRepositoryIdentityKey(previous, key)))
          keys.push(key);
      }
      const fingerprint = parseContentHash(digest.digest("hex"));
      return fingerprint._tag === "err"
        ? refusal({
            reason: "inputs_changed",
            storageReason: "invalid_stored_value",
            file: profileFile,
          })
        : ok({ fingerprint: fingerprint.value, profileBytes, keys });
    } catch {
      return refusal({
        reason: "storage_unavailable",
        storageReason: "io",
        file: profileFile,
      });
    }
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

  /** Activation stays refused; the detail reaches the startup dialog and this log record alike. */
  private refused(
    profileId: WorkspaceProfileId | undefined,
    refused: Refusal,
  ): Result<never, UpgradeRefusal> {
    const detail: UpgradeRefusal = {
      _tag: "UpgradeRefusal",
      profileId,
      reason: refused.reason,
      storageReason: refused.storageReason,
      file: this.locate(refused.file),
      backup:
        refused.backup === undefined ? undefined : this.locate(refused.backup),
    };
    this.record(profileId, "upgrade_refused", detail);
    return err(detail);
  }

  private locate(file: string): UpgradeRefusalFile {
    const config = this.paths.configDirectory();
    return isPathContained(config, file)
      ? { root: "config", path: relative(config, file) }
      : { root: "data", path: relative(this.paths.dataDirectory(), file) };
  }

  private record(
    profileId: WorkspaceProfileId | undefined,
    reason:
      | "upgrade_inventory_started"
      | "upgrade_catalog_reused"
      | "upgrade_catalog_published"
      | "upgrade_profile_activated"
      | "upgrade_refused"
      | "upgrade_writer_exclusion_failed"
      | "upgrade_lock_cleanup_failed",
    refusal?: UpgradeRefusal,
  ): void {
    try {
      this.logs.write({
        process: "main",
        level: reason === "upgrade_refused" ? "error" : "info",
        topic: "local-repository-upgrade",
        message: reason,
        ...definedProps({ profileId }),
        meta:
          refusal === undefined
            ? { reason }
            : {
                reason,
                refusalReason: refusal.reason,
                storageReason: refusal.storageReason,
                file: refusal.file,
                backup: refusal.backup ?? null,
              },
      });
    } catch {
      /* Diagnostics cannot change activation outcomes. */
    }
  }
}
