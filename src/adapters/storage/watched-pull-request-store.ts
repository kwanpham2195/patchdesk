import type { WorkspaceProfileId } from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import {
  parseWatchedPullRequests,
  type WatchedPullRequest,
} from "../../domain/watched-pull-request";
import {
  readJsonFile,
  writeAtomicJson,
  type StorageFailure,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Owns each workspace profile's watched pull request list. */
export class WatchedPullRequestStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  /** The profile's watched list; a profile that never watched one has an empty list. */
  async load(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReadonlyArray<WatchedPullRequest>, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.watchedPullRequestsFile(profileId),
    );
    if (stored._tag === "err")
      return stored.error.reason === "not_found" ? ok([]) : stored;
    const parsed = parseWatchedPullRequests(stored.value);
    return parsed._tag === "ok"
      ? parsed
      : err({
          _tag: "StorageFailure",
          operation: "read",
          reason: "invalid_stored_value",
        });
  }

  /** Replaces the profile's watched list. */
  async save(
    profileId: WorkspaceProfileId,
    list: ReadonlyArray<WatchedPullRequest>,
  ): Promise<Result<void, StorageFailure>> {
    return writeAtomicJson(this.paths.watchedPullRequestsFile(profileId), list);
  }
}
