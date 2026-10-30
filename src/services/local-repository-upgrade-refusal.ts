import type { StorageFailure } from "#src/adapters/storage/json-file";
import type { WorkspaceProfileId } from "#src/domain/ids";
import { err, type Result } from "#src/domain/result";

/** Why startup refused to upgrade a profile; each code names the file a person fixes. */
export type UpgradeRefusalReason =
  | "profile_unreadable"
  | "catalog_damaged"
  | "catalog_mismatch"
  | "conflicting_registrations"
  | "review_unreadable"
  | "backup_conflict"
  | "inputs_changed"
  | "upgrade_locked"
  | "storage_unavailable";

/** A path under the Patchdesk config or data folder, never absolute. */
export type UpgradeRefusalFile = {
  readonly root: "config" | "data";
  readonly path: string;
};

/**
 * The upgrade stopped before activating a profile. `backup` is set only when
 * the pre-upgrade copy of the profile file exists; otherwise `file` or the
 * profile file itself is the one to fix.
 */
export type UpgradeRefusal = {
  readonly _tag: "UpgradeRefusal";
  /** Absent only when a file in the profiles folder is not a valid profile ID. */
  readonly profileId: WorkspaceProfileId | undefined;
  readonly reason: UpgradeRefusalReason;
  readonly storageReason: StorageFailure["reason"];
  readonly file: UpgradeRefusalFile;
  readonly backup: UpgradeRefusalFile | undefined;
};

/** A refusal before the owning root and profile are attached. */
export type Refusal = {
  readonly reason: UpgradeRefusalReason;
  readonly storageReason: StorageFailure["reason"];
  readonly file: string;
  readonly backup?: string;
};

export function refusal(refused: Refusal): Result<never, Refusal> {
  return err(refused);
}
