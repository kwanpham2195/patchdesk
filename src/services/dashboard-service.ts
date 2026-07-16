import type {
  GitHubReadFailure,
  GitHubReader,
} from "../adapters/github/github-adapter";
import type { PullRequestSummary } from "../domain/github-context";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
} from "../domain/ids";
import type {
  WatchedRepoConfig,
  WorkspaceProfileConfig,
} from "../domain/workspace-profile";
import { ok, type Result } from "../domain/result";
import type { WatchedRepoRef } from "./profile-service";

export type PendingPrPriority =
  | "review_requested"
  | "assigned"
  | "recently_updated"
  | "draft"
  | "authored_by_active_account";
export type DashboardRepoState =
  | "ready"
  | "missing_local_path"
  | "github_auth"
  | "github_read"
  | "archived"
  | "no_open_prs";
export type DashboardRow = {
  readonly summary: PullRequestSummary;
  readonly priority: PendingPrPriority;
  readonly badges: ReadonlyArray<"draft" | "authored">;
  readonly repo: WatchedRepoConfig;
};
export type DashboardRepo = {
  readonly repo: WatchedRepoConfig;
  readonly state: DashboardRepoState;
};
export type DashboardPrList = {
  readonly rows: ReadonlyArray<DashboardRow>;
  readonly repos: ReadonlyArray<DashboardRepo>;
  readonly directEntryAvailable: true;
};
export type DiscoveredRepo = WatchedRepoRef;
export type OriginFinder = {
  findOrigins(roots: ReadonlyArray<string>): Promise<ReadonlyArray<string>>;
};

/** Presents only watchlisted GitHub reads and turns dependency failure into row-level dashboard state. */
export class DashboardService {
  constructor(
    private readonly github: GitHubReader,
    private readonly origins?: OriginFinder,
  ) {}

  async listPendingPullRequests(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<DashboardPrList, never>> {
    const archivedRepos = profile.repos
      .filter((repo) => repo.archived === true)
      .map((repo) => ({ repo, state: "archived" as const }));
    const activeRepos = profile.repos.filter((repo) => repo.archived !== true);
    const auth = await this.github.resolveAuthenticatedAccount(profile);
    if (auth._tag === "err")
      return ok({
        rows: [],
        repos: [
          ...archivedRepos,
          ...activeRepos.map((repo) => ({
            repo,
            state: mapFailure(auth.error),
          })),
        ],
        directEntryAvailable: true,
      });

    const rows: DashboardRow[] = [];
    const repos: DashboardRepo[] = [...archivedRepos];
    for (const repo of activeRepos) {
      const list = await this.github.listOpenPullRequests({
        profile,
        repo: {
          host: repo.host,
          owner: repo.owner,
          repo: repo.repo,
          number: 1 as never,
        },
      });
      if (list._tag === "err") {
        repos.push({ repo, state: mapFailure(list.error) });
        continue;
      }
      repos.push({
        repo,
        state:
          list.value.length === 0
            ? "no_open_prs"
            : repo.localPath === undefined
              ? "missing_local_path"
              : "ready",
      });
      rows.push(
        ...list.value.map((summary) =>
          projectRow(summary, repo, profile.ghAccount),
        ),
      );
    }
    rows.sort(
      (left, right) =>
        priorityRank(left.priority) - priorityRank(right.priority),
    );
    return ok({ rows, repos, directEntryAvailable: true });
  }

  /** Refreshes one explicit watchlist repo without reading its siblings. */
  async refreshRepository(
    profile: WorkspaceProfileConfig,
    repo: WatchedRepoConfig,
  ): Promise<Result<DashboardPrList, never>> {
    return await this.listPendingPullRequests({ ...profile, repos: [repo] });
  }

  async discoverWorkspaceRepos(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<ReadonlyArray<DiscoveredRepo>, never>> {
    if (this.origins === undefined) return ok([]);
    const values = await this.origins.findOrigins(profile.workspaceRoots);
    const discovered: DiscoveredRepo[] = [];
    for (const value of values) {
      const parsed = parseGitOrigin(value);
      if (
        parsed === undefined ||
        profile.repos.some((repo) => sameRepo(repo, parsed)) ||
        discovered.some((repo) => sameRepo(repo, parsed))
      )
        continue;
      discovered.push(parsed);
    }
    return ok(discovered);
  }
}

function projectRow(
  summary: PullRequestSummary,
  repo: WatchedRepoConfig,
  account: string,
): DashboardRow {
  const badges: Array<"draft" | "authored"> = [];
  if (summary.isDraft) badges.push("draft");
  if (summary.author === account) badges.push("authored");
  return { summary, repo, priority: priorityFor(summary, account), badges };
}

function priorityFor(
  summary: PullRequestSummary,
  account: string,
): PendingPrPriority {
  if (summary.requestedReviewers?.includes(account)) return "review_requested";
  if (summary.assignees?.includes(account)) return "assigned";
  if (summary.isDraft) return "draft";
  if (summary.author === account) return "recently_updated";
  return "recently_updated";
}

function priorityRank(priority: PendingPrPriority): number {
  return {
    review_requested: 0,
    assigned: 1,
    recently_updated: 2,
    draft: 3,
    authored_by_active_account: 4,
  }[priority];
}

function mapFailure(failure: GitHubReadFailure): DashboardRepoState {
  return failure._tag === "GitHubAuthenticationFailed" ||
    failure.operation === "auth_status"
    ? "github_auth"
    : "github_read";
}

function parseGitOrigin(value: string): DiscoveredRepo | undefined {
  const match =
    /^(?:https:\/\/|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  if (match === null) return undefined;
  const host = parseGitHubHost(match[1]);
  const owner = parseGitHubOwner(match[2]);
  const repo = parseGitHubRepoName(match[3]);
  return host._tag === "ok" && owner._tag === "ok" && repo._tag === "ok"
    ? { host: host.value, owner: owner.value, repo: repo.value }
    : undefined;
}

function sameRepo(left: WatchedRepoRef, right: WatchedRepoRef): boolean {
  return (
    left.host === right.host &&
    left.owner === right.owner &&
    left.repo === right.repo
  );
}
