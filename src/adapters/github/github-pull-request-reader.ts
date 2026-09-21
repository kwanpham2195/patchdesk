import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import {
  type GhRequestRunner,
  type GitHubReadFailure,
  type GitHubReadOperation,
} from "./gh-request-runner";
import type { GitHubRequest } from "./github-request";
import type {
  MaintainerPullRequestPage,
  MaintainerPullRequestSearchPage,
  PullRequestCommit,
  PullRequestSummary,
} from "../../domain/github-context";
import { parseGitSha, type GitSha, type IsoTimestamp } from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import type {
  InboxPageSize,
  InboxStateFilter,
} from "../../domain/maintainer-inbox";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type { WatchedSnapshot } from "../../domain/watched-pull-request";
import {
  maintainerInboxQuery,
  maintainerInboxSearchQuery,
  maxPullRequestCommits,
  repositoryBranchesQuery,
  watchedPullRequestsQuery,
} from "./github-graphql-queries";
import {
  mapReviewDecision,
  parseMaintainerPullRequestPage,
  rollupCheckSummary,
} from "./github-maintainer-inbox-projections";
import {
  maintainerInboxResponseSchema,
  maintainerInboxSearchResponseSchema,
  type MaintainerRateLimit,
  mergeOutcomeSchema,
  pullRequestCommitSchema,
  pullRequestSchema,
  repositoryBranchesResponseSchema,
} from "./github-wire-schemas";
import {
  parseGitHubTimestamp,
  parseMergeOutcome,
  parsePullRequest,
} from "./github-wire-projections";
import { invalid } from "./github-write-failures";
import type {
  MergeOutcome,
  RepositoryBranchListing,
  WatchedPullRequestRead,
} from "./github-adapter";

const watchedPullRequestNodeSchema = v.looseObject({
  state: v.picklist(["OPEN", "MERGED", "CLOSED"]),
  updatedAt: v.string(),
  headRefOid: v.string(),
  reviewDecision: v.nullish(v.string()),
  commits: v.looseObject({
    nodes: v.array(
      v.looseObject({
        commit: v.looseObject({
          statusCheckRollup: v.nullish(v.looseObject({ state: v.string() })),
        }),
      }),
    ),
  }),
});

const watchedPullRequestStates = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
} as const satisfies Record<
  v.InferOutput<typeof watchedPullRequestNodeSchema>["state"],
  WatchedSnapshot["state"]
>;

function parseWatchedSnapshot(
  node: v.InferOutput<typeof watchedPullRequestNodeSchema>,
): WatchedSnapshot | undefined {
  const updatedAt = parseGitHubTimestamp(node.updatedAt);
  const headSha = parseGitSha(node.headRefOid);
  if (updatedAt._tag === "err" || headSha._tag === "err") return undefined;
  return {
    updatedAt: updatedAt.value,
    headSha: headSha.value,
    reviewState: mapReviewDecision(node.reviewDecision),
    checks: rollupCheckSummary(
      node.commits.nodes[0]?.commit.statusCheckRollup?.state,
    ).overall,
    state: watchedPullRequestStates[node.state],
  };
}

function graphqlPullRequestState(state: InboxStateFilter): "OPEN" | "MERGED" {
  return state === "merged" ? "MERGED" : "OPEN";
}

/**
 * Reads pull requests: the open list, the two maintainer-inbox pages, one
 * pull request, its commits, and its merge outcome.
 */
export class GitHubPullRequestReader {
  constructor(private readonly requests: GhRequestRunner) {}

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
  }

  private commandFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<never, GitHubReadFailure> {
    return this.requests.commandFailure(operation, failure, host);
  }

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "rest",
      host: input.profile.githubHost,
      path: `repos/${input.repo.owner}/${input.repo.repo}/pulls?state=open&per_page=100`,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "list_open_prs",
        response.error,
        input.profile.githubHost,
      );
    if (!Array.isArray(response.value)) return invalid("list_open_prs");

    const summaries: Array<PullRequestSummary> = [];
    for (const value of response.value) {
      const raw = v.safeParse(pullRequestSchema, value);
      if (!raw.success) return invalid("list_open_prs");
      const summary = parsePullRequest(
        raw.output,
        input.profile.githubHost,
        input.repo.owner,
        input.repo.repo,
      );
      if (summary._tag === "err") return invalid("list_open_prs");
      summaries.push(summary.value);
    }
    return ok(summaries);
  }

  /** Reads exactly one trusted-state page of pull requests with edge cursors. */
  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly state?: InboxStateFilter;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestPage, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host,
      document: maintainerInboxQuery,
      variables: [
        { kind: "typed", name: "owner", value: input.repo.owner },
        { kind: "typed", name: "name", value: input.repo.repo },
        { kind: "typed", name: "first", value: input.pageSize },
        {
          kind: "typed",
          name: "state",
          value: graphqlPullRequestState(input.state ?? "open"),
        },
        ...(input.cursor === undefined
          ? []
          : [
              {
                kind: "string" as const,
                name: "cursor",
                value: input.cursor,
              },
            ]),
      ],
    });
    if (response._tag === "err")
      return this.commandFailure("list_maintainer_prs", response.error, host);
    const parsed = v.safeParse(maintainerInboxResponseSchema, response.value);
    if (!parsed.success) return invalid("list_maintainer_prs");
    this.recordRateLimit(host, parsed.output.data.rateLimit);
    const page = parseMaintainerPullRequestPage(
      parsed.output.data.repository.pullRequests,
      host,
      input.repo.owner,
      input.repo.repo,
      input.state ?? "open",
    );
    return page === undefined ? invalid("list_maintainer_prs") : ok(page);
  }

  /**
   * Reads one repository-wide `search(type: ISSUE)` page of pull requests
   * with edge cursors, alongside `issueCount` — GitHub's true repository-wide
   * match count for `searchQuery`, distinct from this page's loaded entry
   * count. Mirrors `listMaintainerPullRequests`'s structure; unlike that
   * method, `state` is required here because the search query string alone
   * does not tell the adapter whether the caller is browsing open or merged
   * pull requests, and `parseMaintainerPullRequest` needs it to set
   * `summary.isOpen`.
   */
  async searchMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly searchQuery: string;
    readonly state: InboxStateFilter;
    readonly pageSize: InboxPageSize;
    readonly cursor?: string;
  }): Promise<Result<MaintainerPullRequestSearchPage, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host,
      document: maintainerInboxSearchQuery,
      variables: [
        { kind: "string", name: "search", value: input.searchQuery },
        { kind: "typed", name: "first", value: input.pageSize },
        ...(input.cursor === undefined
          ? []
          : [
              {
                kind: "string" as const,
                name: "cursor",
                value: input.cursor,
              },
            ]),
      ],
    });
    if (response._tag === "err")
      return this.commandFailure("search_maintainer_prs", response.error, host);
    const parsed = v.safeParse(
      maintainerInboxSearchResponseSchema,
      response.value,
    );
    if (!parsed.success) return invalid("search_maintainer_prs");
    this.recordRateLimit(host, parsed.output.data.rateLimit);
    const connection = parsed.output.data.search;
    const page = parseMaintainerPullRequestPage(
      connection,
      host,
      input.repo.owner,
      input.repo.repo,
      input.state,
    );
    return page === undefined
      ? invalid("search_maintainer_prs")
      : ok({ ...page, issueCount: connection.issueCount });
  }

  /** Reads up to 100 branch names of one repository; a non-empty `query` filters by name substring. */
  async listRepositoryBranches(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
    readonly query?: string;
  }): Promise<Result<RepositoryBranchListing, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host,
      document: repositoryBranchesQuery,
      variables: [
        { kind: "typed", name: "owner", value: input.repo.owner },
        { kind: "typed", name: "name", value: input.repo.repo },
        // A string variable keeps a numeric-looking search a GraphQL String.
        ...(input.query !== undefined && input.query.length > 0
          ? [{ kind: "string" as const, name: "search", value: input.query }]
          : []),
      ],
    });
    if (response._tag === "err")
      return this.commandFailure(
        "list_repository_branches",
        response.error,
        host,
      );
    const parsed = v.safeParse(
      repositoryBranchesResponseSchema,
      response.value,
    );
    if (!parsed.success) return invalid("list_repository_branches");
    this.recordRateLimit(host, parsed.output.data.rateLimit);
    const refs = parsed.output.data.repository.refs;
    return ok({
      branches: refs.nodes.map((node) => node.name),
      totalCount: refs.totalCount,
    });
  }

  /**
   * Reads every watched pull request of one profile in one aliased GraphQL
   * call. A host whose last response spent the whole rate limit answers
   * `GitHubRateLimited` without a call until its reset passes.
   */
  async readWatchedPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly refs: ReadonlyArray<PullRequestRef>;
    readonly now: IsoTimestamp;
  }): Promise<
    Result<ReadonlyArray<WatchedPullRequestRead>, GitHubReadFailure>
  > {
    const host = input.profile.githubHost;
    if (input.refs.length === 0) return ok([]);
    const resumeAt = this.requests.exhaustedRateLimit(host, input.now);
    if (resumeAt !== undefined)
      return err({
        _tag: "GitHubRateLimited",
        operation: "get_watched_prs",
        resumeAt,
      });
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host,
      document: watchedPullRequestsQuery(input.refs.length),
      // A string variable keeps a numeric-looking owner or name a GraphQL String.
      variables: input.refs.flatMap((ref, index) => [
        { kind: "string" as const, name: `owner${index}`, value: ref.owner },
        { kind: "string" as const, name: `name${index}`, value: ref.repo },
        { kind: "typed" as const, name: `number${index}`, value: ref.number },
      ]),
    });
    if (response._tag === "err")
      return this.commandFailure("get_watched_prs", response.error, host);
    const parsed = v.safeParse(
      v.looseObject({
        data: v.looseObject({
          rateLimit: v.optional(
            v.looseObject({
              remaining: v.pipe(v.number(), v.integer(), v.minValue(0)),
              resetAt: v.string(),
            }),
          ),
        }),
      }),
      response.value,
    );
    if (!parsed.success) return invalid("get_watched_prs");
    this.recordRateLimit(host, parsed.output.data.rateLimit);
    const reads: WatchedPullRequestRead[] = [];
    for (const [index, ref] of input.refs.entries()) {
      const aliased = v.safeParse(
        v.looseObject({
          pullRequest: v.nullable(watchedPullRequestNodeSchema),
        }),
        parsed.output.data[`pr${index}`],
      );
      if (!aliased.success) return invalid("get_watched_prs");
      const node = aliased.output.pullRequest;
      if (node === null) {
        reads.push({ ref, snapshot: undefined });
        continue;
      }
      const snapshot = parseWatchedSnapshot(node);
      if (snapshot === undefined) return invalid("get_watched_prs");
      reads.push({ ref, snapshot });
    }
    return ok(reads);
  }

  /**
   * Caches the reset time `maintainerInboxQuery` and `maintainerInboxSearchQuery`
   * both carry for free at the top level of a successful response, so a later
   * rate-limited command on the same host can name a resume time instead of
   * falling back to a conservative guess (ADR 0023). An unparseable `resetAt`
   * leaves the previous observation in place: a stale-but-real reset time is
   * better evidence than none.
   */
  private recordRateLimit(host: string, rateLimit: MaintainerRateLimit): void {
    this.requests.recordRateLimit(host, rateLimit);
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "rest",
      host: input.profile.githubHost,
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}`,
    });
    if (response._tag === "err") {
      return this.commandFailure(
        "get_pr",
        response.error,
        input.profile.githubHost,
      );
    }
    const raw = v.safeParse(pullRequestSchema, response.value);
    if (!raw.success) return invalid("get_pr");
    const parsed = parsePullRequest(
      raw.output,
      input.profile.githubHost,
      input.pr.owner,
      input.pr.repo,
    );
    return parsed._tag === "ok" ? parsed : invalid("get_pr");
  }

  async getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "rest",
      host: input.profile.githubHost,
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}`,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_pr",
        response.error,
        input.profile.githubHost,
      );
    const raw = v.safeParse(mergeOutcomeSchema, response.value);
    return raw.success ? parseMergeOutcome(raw.output) : invalid("get_pr");
  }

  async getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    /** The head this list marks `isHead`, when the caller already read it; otherwise this reader reads the pull request for it. */
    readonly headSha?: GitSha;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>> {
    const headSha = await this.resolveHeadSha(input);
    if (headSha._tag === "err") return headSha;
    const response = await this.ghJson(input.profile, {
      kind: "rest",
      paginate: true,
      host: input.profile.githubHost,
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/commits?per_page=100`,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_pr_commits",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(
      v.array(v.array(pullRequestCommitSchema)),
      response.value,
    );
    if (!parsed.success) return invalid("get_pr_commits");
    const rawCommits = parsed.output.flat();
    // GitHub caps this endpoint at 250 entries; without continuation metadata,
    // accepting exactly 250 could persist a truncated list as complete.
    if (rawCommits.length === 0 || rawCommits.length >= maxPullRequestCommits)
      return invalid("get_pr_commits");
    const commits: PullRequestCommit[] = [];
    for (const raw of rawCommits) {
      const sha = parseGitSha(raw.sha);
      const authoredAt =
        raw.commit.author === null
          ? err({ _tag: "Invalid" as const })
          : parseGitHubTimestamp(raw.commit.author.date);
      if (sha._tag === "err" || authoredAt._tag === "err")
        return invalid("get_pr_commits");
      const commit = {
        sha: sha.value,
        message: raw.commit.message,
        author: raw.commit.author?.name ?? "ghost",
        authoredAt: authoredAt.value,
        isHead: sha.value === headSha.value,
      };
      commits.push(
        raw.html_url === undefined ? commit : { ...commit, url: raw.html_url },
      );
    }
    commits.sort((left, right) =>
      right.authoredAt.localeCompare(left.authoredAt),
    );
    return ok(commits);
  }

  /** The caller's own head when it supplied one, otherwise a pull request read for it. */
  private async resolveHeadSha(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha?: GitSha;
  }): Promise<Result<GitSha, GitHubReadFailure>> {
    if (input.headSha !== undefined) return ok(input.headSha);
    const current = await this.getPullRequest(input);
    return current._tag === "err" ? current : ok(current.value.headSha);
  }
}
