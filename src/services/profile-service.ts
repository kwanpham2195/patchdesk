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
  constructor(private readonly store: ProfileStore) {}

  async saveProfile(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<void, StorageFailure>> {
    return await this.store.save(profile);
  }

  async selectProfile(
    profileId: WorkspaceProfileConfig["id"],
  ): Promise<Result<WorkspaceProfileConfig["id"], StorageFailure>> {
    const current = await this.store.loadConfig();
    const config =
      current._tag === "ok"
        ? { ...current.value, lastSelectedProfileId: profileId }
        : { lastSelectedProfileId: profileId, recentPrs: [] };
    const saved = await this.store.saveConfig(config);
    return saved._tag === "ok" ? ok(profileId) : saved;
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
