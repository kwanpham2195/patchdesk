import type { RepositoryIdentity } from "../../domain/repository-identity";

export type DashboardScreenState =
  | "empty"
  | "loading"
  | "success"
  | "error"
  | "no_open_prs";

export type Profile = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots?: ReadonlyArray<string>;
  readonly ownerFilters?: ReadonlyArray<string>;
  readonly rulePaths?: ReadonlyArray<string>;
  readonly repos?: ReadonlyArray<Repo>;
};

/** A watched repository as the renderer holds it: its identity plus the
 * maintainer's optional local checkout. The identity alone is
 * `RepositoryIdentity`; anything that only names a repository should use that
 * instead of this. */
export type Repo = RepositoryIdentity & {
  readonly localPath?: string | undefined;
};

export type RepoOutcome = {
  readonly repo: Repo;
  readonly state: string;
  readonly resumeAt?: string;
  readonly forbiddenReason?: string;
};

export type Dashboard = {
  readonly profile: Profile;
  readonly dashboard: {
    readonly repos: ReadonlyArray<RepoOutcome>;
  };
};

import type { WorkbenchResponse } from "./renderer-contracts";

export type WorkbenchPayload = WorkbenchResponse;

export function repositoryKey(repo: Repo): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}
