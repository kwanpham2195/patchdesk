import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseWorkspaceProfileId,
  type AbsolutePath,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
} from "../domain/ids";
import type {
  PatchdeskConfigFile,
  PatchdeskSettingsPatch,
} from "../domain/contracts";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type {
  WatchedRepoConfig,
  WorkspaceProfileConfig,
} from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";

export type WatchedRepoRef = {
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
};

export type ProfileMutationFailure = {
  readonly _tag: "ProfileMutationFailure";
  readonly reason: "duplicate_repo" | "repo_not_found" | "invalid_local_path";
};

/** Persists profile and active-profile choices through the only JSON storage boundary. */
export class ProfileSettingsService {
  private configMutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly store: ProfileStore) {}

  async saveProfile(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<void, StorageFailure>> {
    return await this.store.save(profile);
  }

  async selectProfile(
    profileId: WorkspaceProfileConfig["id"],
  ): Promise<Result<WorkspaceProfileConfig["id"], StorageFailure>> {
    return await this.runConfigMutation(async () => {
      const current = await this.store.loadConfig();
      if (current._tag === "err" && current.error.reason !== "not_found") {
        return current;
      }
      const config =
        current._tag === "ok"
          ? { ...current.value, lastSelectedProfileId: profileId }
          : { lastSelectedProfileId: profileId };
      const saved = await this.store.saveConfig(config);
      return saved._tag === "ok" ? ok(profileId) : saved;
    });
  }

  /** Loads normalized global settings, treating a missing first-run file as an empty config. */
  async loadSettings(): Promise<Result<PatchdeskConfigFile, StorageFailure>> {
    const stored = await this.store.loadConfig();
    if (stored._tag === "ok") return stored;
    return stored.error.reason === "not_found" ? ok({}) : stored;
  }

  /** Persists a parsed settings patch without changing the selected workspace profile. */
  async updateSettings(
    patch: PatchdeskSettingsPatch,
  ): Promise<Result<PatchdeskConfigFile, StorageFailure>> {
    return await this.runConfigMutation(async () => {
      const current = await this.loadSettings();
      if (current._tag === "err") return current;
      const next = { ...current.value, ...patch };
      const saved = await this.store.saveConfig(next);
      return saved._tag === "ok" ? ok(next) : saved;
    });
  }

  private async runConfigMutation<T>(
    mutation: () => Promise<Result<T, StorageFailure>>,
  ): Promise<Result<T, StorageFailure>> {
    const scheduled = this.configMutationTail.then(mutation, mutation);
    this.configMutationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return await scheduled;
  }
}

/** Example first-run profile; it has no watched repos and never conveys a credential. */
export function createDefaultCfwProfile(): Result<
  WorkspaceProfileConfig,
  ProfileMutationFailure
> {
  const id = parseWorkspaceProfileId("cfw");
  const host = parseGitHubHost("github.com");
  const owner = parseGitHubOwner("centraldigital");
  const root = parseAbsolutePath("/Users/kwanpham/Work/cfw");
  if (
    id._tag === "err" ||
    host._tag === "err" ||
    owner._tag === "err" ||
    root._tag === "err"
  ) {
    return err({
      _tag: "ProfileMutationFailure",
      reason: "invalid_local_path",
    });
  }
  return ok({
    id: id.value,
    label: "CFW",
    githubHost: host.value,
    ghAccount: "pmquan2cfw",
    ownerFilters: [owner.value],
    workspaceRoots: [root.value],
    rulePaths: [],
    repos: [],
    analysisMergePolicy: "require_acknowledgement",
  });
}

/** Adds an explicitly chosen repo; discovery suggestions cannot enter the watchlist implicitly. */
export function addWatchedRepo(
  profile: WorkspaceProfileConfig,
  repo: WatchedRepoConfig,
): Result<WorkspaceProfileConfig, ProfileMutationFailure> {
  if (profile.repos.some((candidate) => sameRepo(candidate, repo))) {
    return err({ _tag: "ProfileMutationFailure", reason: "duplicate_repo" });
  }
  return ok({ ...profile, repos: [...profile.repos, repo] });
}

/** Changes only the optional local checkout association for one watched GitHub repo. */
export function updateWatchedRepoPath(
  profile: WorkspaceProfileConfig,
  target: WatchedRepoRef,
  localPath: string | undefined,
): Result<WorkspaceProfileConfig, ProfileMutationFailure> {
  const parsedPath =
    localPath === undefined ? undefined : parseAbsolutePath(localPath);
  if (parsedPath !== undefined && parsedPath._tag === "err") {
    return err({
      _tag: "ProfileMutationFailure",
      reason: "invalid_local_path",
    });
  }
  if (!profile.repos.some((candidate) => sameRepo(candidate, target))) {
    return err({ _tag: "ProfileMutationFailure", reason: "repo_not_found" });
  }
  const path: AbsolutePath | undefined =
    parsedPath === undefined ? undefined : parsedPath.value;
  return ok({
    ...profile,
    repos: profile.repos.map((repo) =>
      sameRepo(repo, target)
        ? {
            host: repo.host,
            owner: repo.owner,
            repo: repo.repo,
            ...(path === undefined ? {} : { localPath: path }),
          }
        : repo,
    ),
  });
}

/** Removes one repo from the user-maintained watchlist without affecting other profile settings. */
export function removeWatchedRepo(
  profile: WorkspaceProfileConfig,
  target: WatchedRepoRef,
): Result<WorkspaceProfileConfig, ProfileMutationFailure> {
  if (!profile.repos.some((candidate) => sameRepo(candidate, target))) {
    return err({ _tag: "ProfileMutationFailure", reason: "repo_not_found" });
  }
  return ok({
    ...profile,
    repos: profile.repos.filter((repo) => !sameRepo(repo, target)),
  });
}

function sameRepo(left: WatchedRepoRef, right: WatchedRepoRef): boolean {
  return (
    left.host === right.host &&
    left.owner === right.owner &&
    left.repo === right.repo
  );
}
