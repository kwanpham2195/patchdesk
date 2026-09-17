import type { GitHubReader } from "../adapters/github/github-adapter";
import type { GitHubReadFailure } from "../adapters/github/gh-request-runner";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { WatchedPullRequestStore } from "../adapters/storage/watched-pull-request-store";
import type { IsoTimestamp, WorkspaceProfileId } from "../domain/ids";
import { KeyedMutex } from "../domain/keyed-mutex";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import {
  checkWatchCapacity,
  unwatchPullRequest,
  watchPullRequest,
  type WatchLimitReached,
} from "../domain/watched-pull-request";

/** Why a watch or unwatch did not change the list. */
export type WatchedPullRequestFailure =
  | WatchLimitReached
  | { readonly _tag: "WatchedPullRequestNotFound" }
  | {
      readonly _tag: "WatchedPullRequestReadFailed";
      readonly reason: GitHubReadFailure["_tag"];
    }
  | StorageFailure;

type WatchedPullRequestServiceDependencies = {
  readonly profiles: Pick<ProfileStore, "load">;
  readonly store: WatchedPullRequestStore;
  readonly github: Pick<GitHubReader, "readWatchedPullRequests">;
  readonly now: () => IsoTimestamp;
};

/**
 * Owns each profile's watched pull request list (ADR 0045). Every change to
 * the stored list runs under one per-profile lock, so a watch and a poll
 * writing the same file never drop each other's change.
 */
export class WatchedPullRequestService {
  private readonly locks = new KeyedMutex();

  constructor(
    private readonly dependencies: WatchedPullRequestServiceDependencies,
  ) {}

  /** The pull requests the profile watches, in the order they were watched. */
  async list(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReadonlyArray<PullRequestRef>, StorageFailure>> {
    const stored = await this.dependencies.store.load(profileId);
    return stored._tag === "ok"
      ? ok(stored.value.map((watched) => watched.ref))
      : stored;
  }

  /**
   * Watches `ref`, reading its current GitHub state as the baseline the
   * first poll compares against. The cap is checked before the read, so a
   * refused watch costs no GitHub call.
   */
  async watch(
    profileId: WorkspaceProfileId,
    ref: PullRequestRef,
  ): Promise<Result<ReadonlyArray<PullRequestRef>, WatchedPullRequestFailure>> {
    const profile = await this.dependencies.profiles.load(profileId);
    if (profile._tag === "err")
      return profile.error.reason === "not_found"
        ? err({ _tag: "WatchedPullRequestNotFound" })
        : profile;
    if (profile.value.githubHost !== ref.host)
      return err({ _tag: "WatchedPullRequestNotFound" });
    const before = await this.dependencies.store.load(profileId);
    if (before._tag === "err") return before;
    const capacity = checkWatchCapacity(before.value, ref);
    if (capacity._tag === "err") return capacity;
    const read = await this.dependencies.github.readWatchedPullRequests({
      profile: profile.value,
      refs: [ref],
      now: this.dependencies.now(),
    });
    if (read._tag === "err")
      return err({
        _tag: "WatchedPullRequestReadFailed",
        reason: read.error._tag,
      });
    const snapshot = read.value[0]?.snapshot;
    if (snapshot === undefined)
      return err({ _tag: "WatchedPullRequestNotFound" });
    return this.locks.run(profileId, async () => {
      const current = await this.dependencies.store.load(profileId);
      if (current._tag === "err") return current;
      const next = watchPullRequest(current.value, {
        ref,
        snapshot,
        watchedAt: this.dependencies.now(),
      });
      if (next._tag === "err") return next;
      const saved = await this.dependencies.store.save(profileId, next.value);
      return saved._tag === "ok"
        ? ok(next.value.map((watched) => watched.ref))
        : saved;
    });
  }

  /** Stops watching `ref`; an unwatched ref succeeds with the list unchanged. */
  async unwatch(
    profileId: WorkspaceProfileId,
    ref: PullRequestRef,
  ): Promise<Result<ReadonlyArray<PullRequestRef>, StorageFailure>> {
    return this.locks.run(profileId, async () => {
      const current = await this.dependencies.store.load(profileId);
      if (current._tag === "err") return current;
      const next = unwatchPullRequest(current.value, ref);
      const saved = await this.dependencies.store.save(profileId, next);
      return saved._tag === "ok"
        ? ok(next.map((watched) => watched.ref))
        : saved;
    });
  }
}
