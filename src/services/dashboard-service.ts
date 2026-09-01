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

type DiscoveredRepo = WatchedRepoRef & {
  readonly localPath: AbsolutePath;
};
type DiscoveredWorkspaceOrigin = {
  readonly origin: string;
  readonly localPath: string;
};
/** One root's bounded checkout scan outcome from the main-process adapter. */
export type WorkspaceOriginRootResult =
  | {
      readonly root: string;
      readonly state: "ready";
      readonly origins: ReadonlyArray<DiscoveredWorkspaceOrigin>;
    }
  | {
      readonly root: string;
      readonly state: "failed";
      readonly reason: "scan_failed";
    };
/** One root's repository suggestions after origin parsing and watchlist filtering. */
export type DiscoveredWorkspaceRootResult =
  | {
      readonly root: string;
      readonly state: "ready";
      readonly repositories: ReadonlyArray<DiscoveredRepo>;
    }
  | {
      readonly root: string;
      readonly state: "failed";
      readonly reason: "scan_failed";
    };
export type OriginFinder = {
  find(
    roots: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<WorkspaceOriginRootResult>>;
};

/** Suggests watchlist candidates from the git origins found under the profile's workspace roots, skipping repositories it already watches. */
export class DashboardService {
  constructor(private readonly origins?: OriginFinder) {}

  async discoverWorkspaceRepos(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<ReadonlyArray<DiscoveredWorkspaceRootResult>, never>> {
    if (this.origins === undefined) return ok([]);
    const values = await this.origins.find(profile.workspaceRoots);
    const discovered: DiscoveredRepo[] = [];
    const results: DiscoveredWorkspaceRootResult[] = [];
    for (const value of values) {
      if (value.state === "failed") {
        results.push({
          root: value.root,
          state: "failed",
          reason: "scan_failed",
        });
        continue;
      }
      const repositories: DiscoveredRepo[] = [];
      for (const origin of value.origins) {
        const parsed = parseGitOrigin(origin.origin, origin.localPath);
        if (
          parsed === undefined ||
          profile.repos.some((repo) => sameRepositoryIdentity(repo, parsed)) ||
          discovered.some((repo) => sameRepositoryIdentity(repo, parsed))
        )
          continue;
        discovered.push(parsed);
        repositories.push(parsed);
      }
      results.push({ root: value.root, state: "ready", repositories });
    }
    return ok(results);
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
