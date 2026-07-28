import { err, ok, type Result } from "../domain/result";
import {
  parseReviewSessionId,
  type IsoTimestamp,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import {
  discardReviewSession,
  type ReviewSession,
  type ReviewSessionState,
} from "../domain/review-session";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseQuarantineEntryName,
  type QuarantineFailure,
  type ReviewArtifactStorage,
} from "../adapters/storage/review-artifact-storage";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { GitReadExecutor } from "./review-worktree-service";
import { ReviewLifecycleGate } from "./review-lifecycle-gate";

export type TrashMover = {
  move(path: string): Promise<Result<void, StorageFailure>>;
};

export type StorageSessionProjection = {
  readonly id: string;
  readonly prLabel: string;
  readonly state: ReviewSessionState["_tag"];
  readonly updatedAt: string;
  readonly canDiscard: boolean;
};

export type StorageOverview = {
  readonly sessions: ReadonlyArray<StorageSessionProjection>;
  readonly quarantined: ReadonlyArray<{
    readonly entryName: string;
    readonly quarantinedAt: string;
  }>;
  readonly cacheBytes: number;
};

export type StorageDiscardInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
};

export type StorageDeleteQuarantinedInput = {
  readonly profileId: WorkspaceProfileId;
  readonly entryName: string;
};

export type StorageClearCacheInput = {
  readonly profileId: WorkspaceProfileId;
};

export type StorageManagementFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "ProfileUnavailable" }
  | { readonly _tag: "StorageUnavailable" }
  | { readonly _tag: "SessionRunning" }
  | { readonly _tag: "SessionImmutable" }
  | { readonly _tag: "SessionNotDiscardable" }
  | { readonly _tag: "SessionNotFound" }
  | { readonly _tag: "InvalidQuarantineEntryName" }
  | { readonly _tag: "TrashUnavailable" };

type StorageManagementDependencies = {
  readonly profiles: ProfileStore;
  readonly sessions: ReviewSessionStore;
  readonly artifacts: ReviewArtifactStorage;
  readonly paths: PatchdeskPaths;
  readonly trash?: TrashMover;
  readonly git: GitReadExecutor;
  readonly now: () => IsoTimestamp;
  readonly lifecycleGate?: ReviewLifecycleGate;
};

/**
 * Use-case service for the Settings storage section. Owns the policy and
 * ordering of discard, quarantine delete, and cache clear, and exposes a
 * path-free projection that the renderer can safely display.
 */
export class StorageManagementService {
  private readonly lifecycleGate: ReviewLifecycleGate;

  constructor(private readonly deps: StorageManagementDependencies) {
    this.lifecycleGate = deps.lifecycleGate ?? new ReviewLifecycleGate();
  }

  async list(profileId: WorkspaceProfileId): Promise<Result<StorageOverview, StorageManagementFailure>> {
    const profileResult = await this.deps.profiles.load(profileId);
    if (profileResult._tag === "err") {
      return err(
        profileResult.error.reason === "not_found"
          ? { _tag: "ProfileNotFound" }
          : { _tag: "ProfileUnavailable" },
      );
    }
    const listed = await this.deps.sessions.listSessions(profileId);
    if (listed._tag === "err") return err({ _tag: "StorageUnavailable" });
    const quarantined = await this.deps.artifacts.listQuarantined(profileId);
    if (quarantined._tag === "err") return err({ _tag: "StorageUnavailable" });
    const cacheBytes = await this.deps.artifacts.cacheBytes(profileId);
    if (cacheBytes._tag === "err") return err({ _tag: "StorageUnavailable" });
    return ok({
      sessions: listed.value.map((session) => projectSession(session)),
      quarantined: quarantined.value,
      cacheBytes: cacheBytes.value,
    });
  }

  async discard(
    input: StorageDiscardInput,
  ): Promise<Result<undefined, StorageManagementFailure>> {
    const sessionResult = await this.deps.sessions.load(input.profileId, input.sessionId);
    if (sessionResult._tag === "err") {
      return err(
        sessionResult.error.reason === "not_found"
          ? { _tag: "SessionNotFound" }
          : { _tag: "StorageUnavailable" },
      );
    }
    const session = sessionResult.value;
    if (session.state._tag === "Running") {
      return err({ _tag: "SessionRunning" });
    }
    if (session.state._tag === "Merged") {
      return err({ _tag: "SessionImmutable" });
    }
    if (
      session.state._tag !== "Created" &&
      session.state._tag !== "ReviewFailed" &&
      session.state._tag !== "ReviewCompleted" &&
      session.state._tag !== "Stale" &&
      session.state._tag !== "Discarded"
    ) {
      return err({ _tag: "SessionNotDiscardable" });
    }
    if (session.state._tag === "Discarded") {
      return err({ _tag: "SessionNotDiscardable" });
    }
    const discarded = discardReviewSession(session, this.deps.now());
    if (discarded._tag === "err") {
      return err(mapDiscardError(discarded.error));
    }
    const saved = await this.deps.sessions.save(discarded.value);
    if (saved._tag === "err") return err({ _tag: "StorageUnavailable" });
    const removed = await this.removeManagedWorktree(input.profileId, session);
    if (removed._tag === "err") return err({ _tag: "StorageUnavailable" });
    return ok(undefined);
  }

  async deleteQuarantined(
    input: StorageDeleteQuarantinedInput,
  ): Promise<Result<undefined, StorageManagementFailure>> {
    const parsed = parseQuarantineEntryName(input.entryName);
    if (parsed._tag === "err") return err({ _tag: "InvalidQuarantineEntryName" });
    if (this.deps.trash === undefined) {
      return err({ _tag: "TrashUnavailable" });
    }
    const sessionPresent = await this.deps.artifacts.hasQuarantinedSession(
      input.profileId,
      parsed.value,
    );
    if (sessionPresent._tag === "err") return err({ _tag: "StorageUnavailable" });
    if (!sessionPresent.value) return err({ _tag: "SessionNotFound" });
    const sessionPath = this.deps.paths.quarantinedSessionDirectory(input.profileId, parsed.value);
    const worktreePath = this.deps.paths.quarantinedWorktreeDirectory(input.profileId, parsed.value);
    const movedSession = await this.deps.trash.move(sessionPath);
    if (movedSession._tag === "err") return err({ _tag: "StorageUnavailable" });
    const worktreePresent = await this.deps.artifacts.hasQuarantinedWorktree(
      input.profileId,
      parsed.value,
    );
    if (worktreePresent._tag === "err") return err({ _tag: "StorageUnavailable" });
    if (worktreePresent.value) {
      const movedWorktree = await this.deps.trash.move(worktreePath);
      if (movedWorktree._tag === "err") return err({ _tag: "StorageUnavailable" });
    }
    return ok(undefined);
  }

  async clearLocalData(
    profileId: WorkspaceProfileId,
  ): Promise<Result<undefined, StorageManagementFailure>> {
    return this.lifecycleGate.withProfileLock(profileId, async () => {
      const profile = await this.deps.profiles.load(profileId);
      if (profile._tag === "err") {
        return err(
          profile.error.reason === "not_found"
            ? { _tag: "ProfileNotFound" }
            : { _tag: "ProfileUnavailable" },
        );
      }
      const clearedCache = await this.clearCacheUnlocked(profileId, profile.value.repos);
      if (clearedCache._tag === "err") return clearedCache;
      const scanned = await this.deps.sessions.scanSessionEntries(profileId);
      if (scanned._tag === "err") return err({ _tag: "StorageUnavailable" });
      for (const invalid of scanned.value.invalidEntries) {
        const quarantined = invalid.sessionId === undefined
          ? await this.deps.artifacts.quarantineInvalidEntry(profileId, invalid.entryName)
          : await this.deps.artifacts.quarantine(profileId, invalid.sessionId);
        if (quarantined._tag === "err") return err({ _tag: "StorageUnavailable" });
        const removed = await this.deps.artifacts.removeQuarantined(profileId, quarantined.value.entryName);
        if (removed._tag === "err") return err({ _tag: "StorageUnavailable" });
      }
      for (const session of scanned.value.sessions) {
        if (session.state._tag !== "Discarded") continue;
        const removed = await this.deps.artifacts.removeSession(profileId, session.id);
        if (removed._tag === "err") return err({ _tag: "StorageUnavailable" });
      }
      const quarantined = await this.deps.artifacts.listQuarantined(profileId);
      if (quarantined._tag === "err") return err({ _tag: "StorageUnavailable" });
      for (const entry of quarantined.value) {
        const removed = await this.deps.artifacts.removeQuarantined(profileId, entry.entryName);
        if (removed._tag === "err") return err({ _tag: "StorageUnavailable" });
      }
      return ok(undefined);
    });
  }

  async clearCache(
    profileId: WorkspaceProfileId,
  ): Promise<Result<undefined, StorageManagementFailure>> {
    return this.lifecycleGate.withProfileLock(profileId, async () => {
      const profile = await this.deps.profiles.load(profileId);
      if (profile._tag === "err") {
        return err(
          profile.error.reason === "not_found"
            ? { _tag: "ProfileNotFound" }
            : { _tag: "ProfileUnavailable" },
        );
      }
      return this.clearCacheUnlocked(profileId, profile.value.repos);
    });
  }

  private async clearCacheUnlocked(
    profileId: WorkspaceProfileId,
    repos: ReadonlyArray<{ readonly localPath?: string }>,
  ): Promise<Result<undefined, StorageManagementFailure>> {
    const listed = await this.deps.sessions.listSessions(profileId);
    if (listed._tag === "err") return err({ _tag: "StorageUnavailable" });
    const protectedIds = new Set<string>(
      listed.value
        .filter((session) => session.state._tag === "Running")
        .map((session) => session.id),
    );
    const removable = await this.cacheChildrenExcept(profileId, protectedIds);
    if (removable._tag === "err") return removable;
    const removed = await this.deps.artifacts.removeCacheChildren(profileId, removable.value);
    if (removed._tag === "err") return err({ _tag: "StorageUnavailable" });
    const pruned = await this.prunePerLocalPath(repos);
    if (pruned._tag === "err") return err({ _tag: "StorageUnavailable" });
    return ok(undefined);
  }

  private async cacheChildrenExcept(
    profileId: WorkspaceProfileId,
    protectedIds: ReadonlySet<string>,
  ): Promise<Result<ReadonlyArray<string>, StorageManagementFailure>> {
    const all = await this.deps.artifacts.cacheChildren(profileId);
    if (all._tag === "err") return err({ _tag: "StorageUnavailable" });
    const protectedWithRecordedState = new Set(protectedIds);
    for (const entry of all.value) {
      if (protectedWithRecordedState.has(entry)) continue;
      const sessionId = parseReviewSessionId(entry);
      if (sessionId._tag === "err") continue;
      const recordedRunning = await this.deps.sessions.isRecordedRunning(
        profileId,
        sessionId.value,
      );
      if (recordedRunning._tag === "err") {
        return err({ _tag: "StorageUnavailable" });
      }
      if (recordedRunning.value) protectedWithRecordedState.add(entry);
    }
    return ok(
      all.value.filter((entry) => !protectedWithRecordedState.has(entry)),
    );
  }

  private async prunePerLocalPath(
    repos: ReadonlyArray<{ readonly localPath?: string }>,
  ): Promise<Result<undefined, QuarantineFailure>> {
    const seen = new Set<string>();
    for (const repo of repos) {
      if (repo.localPath === undefined) continue;
      if (seen.has(repo.localPath)) continue;
      seen.add(repo.localPath);
      const result = await this.deps.git.run([
        "git",
        "-C",
        repo.localPath,
        "worktree",
        "prune",
      ]);
      if (result._tag === "err") {
        return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
      }
    }
    return ok(undefined);
  }

  private async removeManagedWorktree(
    profileId: WorkspaceProfileId,
    session: ReviewSession,
  ): Promise<Result<undefined, QuarantineFailure>> {
    return this.deps.artifacts.removeCacheChildren(profileId, [session.id]);
  }
}

function projectSession(session: ReviewSession): StorageSessionProjection {
  const key = session.key;
  const prLabel = `${key.owner}/${key.repo}#${key.prNumber}`;
  const canDiscard =
    session.state._tag === "Created" ||
    session.state._tag === "ReviewFailed" ||
    session.state._tag === "ReviewCompleted" ||
    session.state._tag === "Stale" ||
    session.state._tag === "Discarded";
  return {
    id: session.id,
    prLabel,
    state: session.state._tag,
    updatedAt: session.updatedAt,
    canDiscard,
  };
}

function mapDiscardError(
  error:
    | { readonly _tag: "SessionImmutable" }
    | { readonly _tag: "SessionRunning" }
    | { readonly _tag: "SessionNotDiscardable" },
): StorageManagementFailure {
  if (error._tag === "SessionImmutable") return { _tag: "SessionImmutable" };
  if (error._tag === "SessionRunning") return { _tag: "SessionRunning" };
  return { _tag: "SessionNotDiscardable" };
}
