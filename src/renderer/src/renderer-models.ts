export type DashboardScreenState =
  | "empty"
  | "loading"
  | "success"
  | "degraded"
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

export type Repo = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly localPath?: string;
};

export type RepoOutcome = {
  readonly repo: Repo;
  readonly state: string;
  readonly resumeAt?: string;
};

export type PrRow = {
  readonly summary: {
    readonly ref: {
      readonly host: string;
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
    };
    readonly title: string;
    readonly description?: string;
    readonly author: string;
    readonly checkSummary?: { readonly overall: string };
  };
  readonly priority: string;
  readonly badges: ReadonlyArray<string>;
};

export type Dashboard = {
  readonly profile: Profile;
  readonly dashboard: {
    readonly rows: ReadonlyArray<PrRow>;
    readonly repos: ReadonlyArray<RepoOutcome>;
  };
};

export type Preview = {
  readonly pr: {
    readonly host?: string;
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  };
  readonly confirmation: {
    readonly required: boolean;
    readonly targetProfileId?: string;
  };
};

import type { WorkbenchResponse } from "./renderer-contracts";

export type WorkbenchPayload = WorkbenchResponse;

export type ReviewRecord = {
  readonly id: string;
  readonly profileId: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly title?: string;
  readonly state: string;
  readonly draftState?: string;
  readonly updatedAt: string;
};

export function repositoryKey(repo: Repo): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}
