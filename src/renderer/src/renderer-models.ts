export type DashboardScreenState =
  | "empty"
  | "loading"
  | "success"
  | "degraded"
  | "error"
  | "archived"
  | "no_open_prs";

export type Profile = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots?: ReadonlyArray<string>;
  readonly ownerFilters?: ReadonlyArray<string>;
  readonly rulePaths?: ReadonlyArray<string>;
};

export type Repo = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly localPath?: string;
  readonly archived?: boolean;
};

export type RepoOutcome = {
  readonly repo: Repo;
  readonly state: string;
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

export type WorkbenchPayload = {
  readonly state: "review_started" | "completed";
  readonly session: {
    readonly id: string;
    readonly key: {
      readonly profileId: string;
      readonly host: string;
      readonly owner: string;
      readonly repo: string;
      readonly prNumber: number;
      readonly headSha: string;
    };
  };
  readonly recoveryView?: {
    readonly noticeKey: "preparing" | "ready_to_review" | "review_in_progress" | "review_interrupted" | "review_failed" | "needs_preparation";
    readonly tone: "neutral" | "positive" | "warning" | "destructive";
    readonly actionKey?: "run_review" | "reconnect" | "start_again" | "try_again" | "prepare_again";
  };
  readonly result?: unknown;
  readonly draft?: unknown;
  readonly comments?: unknown;
  readonly checks?: unknown;
  readonly history?: unknown;
  readonly mergeReadiness?: unknown;
  readonly runId?: string;
  readonly reviewScope?: unknown;
  readonly fullPatch?: string;
  readonly comparison?: unknown;
  readonly comparisonPatch?: string;
  readonly lifecycle?: unknown;
  readonly comparisonAvailability?:
    "available" | "not_requested" | "incomplete" | "missing";
  readonly pullRequest?: {
    readonly ref: {
      readonly host?: string;
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
    };
    readonly title: string;
    readonly description?: string;
    readonly author: string;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headSha: string;
  };
  readonly reviewedHeadSha?: string;
  readonly currentHeadSha?: string;
  readonly freshness?: "fresh" | "stale" | "unavailable";
  readonly refreshedAt?: string;
};

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
