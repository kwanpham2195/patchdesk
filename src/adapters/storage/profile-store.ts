import {
  parsePatchdeskConfig,
  type PatchdeskConfigFile,
} from "../../domain/contracts";
import {
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "../../domain/workspace-profile";
import { err, type Result } from "../../domain/result";
import type { WorkspaceProfileId } from "../../domain/ids";
import {
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Owns the profile JSON boundary and never persists ambient credentials. */
export class ProfileStore {
  constructor(private readonly paths: PatchdeskPaths) {}

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
    if (parsed._tag === "err") {
      return err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      });
    }

    return parsed;
  }
}
