import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  type AbsolutePath,
} from "../domain/ids";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { ok, type Result } from "../domain/result";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import type { WatchedRepoRef } from "./profile-service";

export type DiscoveredRepo = WatchedRepoRef & {
  readonly localPath: AbsolutePath;
};
export type DiscoveredWorkspaceOrigin = {
  readonly origin: string;
  readonly localPath: string;
};
export type OriginFinder = {
  findOrigins(
    roots: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<DiscoveredWorkspaceOrigin>>;
};

/** Suggests watchlist candidates from the git origins found under the profile's workspace roots, skipping repositories it already watches. */
export class DashboardService {
  constructor(private readonly origins?: OriginFinder) {}

  async discoverWorkspaceRepos(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<ReadonlyArray<DiscoveredRepo>, never>> {
    if (this.origins === undefined) return ok([]);
    const values = await this.origins.findOrigins(profile.workspaceRoots);
    const discovered: DiscoveredRepo[] = [];
    for (const value of values) {
      const parsed = parseGitOrigin(value.origin, value.localPath);
      if (
        parsed === undefined ||
        profile.repos.some((repo) => sameRepositoryIdentity(repo, parsed)) ||
        discovered.some((repo) => sameRepositoryIdentity(repo, parsed))
      )
        continue;
      discovered.push(parsed);
    }
    return ok(discovered);
  }
}

function parseGitOrigin(
  value: string,
  localPath: string,
): DiscoveredRepo | undefined {
  const match =
    /^(?:https:\/\/|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  if (match === null) return undefined;
  const host = parseGitHubHost(match[1]);
  const owner = parseGitHubOwner(match[2]);
  const repo = parseGitHubRepoName(match[3]);
  const path = parseAbsolutePath(localPath);
  return host._tag === "ok" &&
    owner._tag === "ok" &&
    repo._tag === "ok" &&
    path._tag === "ok"
    ? {
        host: host.value,
        owner: owner.value,
        repo: repo.value,
        localPath: path.value,
      }
    : undefined;
}
