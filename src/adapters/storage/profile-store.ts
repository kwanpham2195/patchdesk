import { createHash } from "node:crypto";
import { LocalRepositoryStore } from "./local-repository-store";
import { parseContentHash } from "#src/domain/ids";
import {
  parsePatchdeskConfig,
  type PatchdeskConfigFile,
} from "#src/domain/contracts";
import { readdir } from "node:fs/promises";
import {
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "#src/domain/workspace-profile";
import { err, type Result } from "#src/domain/result";
import {
  parseWorkspaceProfileId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  isNotFound,
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Owns the profile JSON boundary and never persists ambient credentials. */
export class ProfileStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async loadRepositories(profileId: WorkspaceProfileId) {
    return new LocalRepositoryStore(this.paths).load(profileId);
  }

  async saveConfig(config: unknown): Promise<Result<void, StorageFailure>> {
    const parsed = parsePatchdeskConfig(config);
    if (parsed._tag === "err") {
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      });
    }

    return writeAtomicJson(this.paths.configFile(), parsed.value);
  }

  async loadConfig(): Promise<Result<PatchdeskConfigFile, StorageFailure>> {
    const stored = await readJsonFile(this.paths.configFile());
    if (stored._tag === "err") {
      return stored;
    }

    const parsed = parsePatchdeskConfig(stored.value);
    if (parsed._tag === "err") {
      return err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      });
    }

    return parsed;
  }

  async save(profile: unknown): Promise<Result<void, StorageFailure>> {
    const parsed = parseWorkspaceProfileConfig(profile);
    if (parsed._tag === "err") {
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      });
    }

    const catalogStore = new LocalRepositoryStore(this.paths);
    const catalog = await catalogStore.load(parsed.value.id);
    if (catalog._tag === "err") {
      if (catalog.error.reason !== "not_found") return catalog;
      const existing = await readJsonFile(
        this.paths.profileFile(parsed.value.id),
      );
      if (existing._tag === "ok" || existing.error.reason !== "not_found")
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "invalid_stored_value",
        });
      const fingerprint = parseContentHash(
        createHash("sha256").update("fresh-profile/1").digest("hex"),
      );
      if (fingerprint._tag === "err")
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "invalid_stored_value",
        });
      const created = await catalogStore.save({
        format: 1,
        profileId: parsed.value.id,
        generationId: parsed.value.localRepositoryCatalogGeneration,
        revision: 1,
        repositories: [],
        bootstrapInputFingerprint: fingerprint.value,
      });
      if (created._tag === "err") return created;
    } else if (
      catalog.value.generationId !==
      parsed.value.localRepositoryCatalogGeneration
    )
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      });
    return writeAtomicJson(
      this.paths.profileFile(parsed.value.id),
      parsed.value,
    );
  }

  async load(
    profileId: WorkspaceProfileId,
  ): Promise<Result<WorkspaceProfileConfig, StorageFailure>> {
    const stored = await readJsonFile(this.paths.profileFile(profileId));
    if (stored._tag === "err") {
      return stored;
    }

    const parsed = parseWorkspaceProfileConfig(stored.value);
    if (parsed._tag === "err" || parsed.value.id !== profileId) {
      return err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      });
    }

    const catalog = await new LocalRepositoryStore(this.paths).load(profileId);
    if (catalog._tag === "err") return catalog;
    return catalog.value.generationId ===
      parsed.value.localRepositoryCatalogGeneration
      ? parsed
      : err({
          _tag: "StorageFailure",
          operation: "read",
          reason: "invalid_stored_value",
        });
  }

  /** Lists persisted profiles; no profiles is a normal first-run result. */
  async list(): Promise<
    Result<ReadonlyArray<WorkspaceProfileConfig>, StorageFailure>
  > {
    let names: ReadonlyArray<string>;
    try {
      names = await readdir(`${this.paths.configDirectory()}/profiles`);
    } catch (cause: unknown) {
      if (isNotFound(cause)) {
        return { _tag: "ok", value: [] };
      }
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
    const profiles: WorkspaceProfileConfig[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = parseWorkspaceProfileId(name.slice(0, -5));
      if (id._tag === "err") continue;
      const loaded = await this.load(id.value);
      if (loaded._tag === "err") return loaded;
      profiles.push(loaded.value);
    }
    return { _tag: "ok", value: profiles };
  }
}
