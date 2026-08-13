import type { GitHubReader } from "../adapters/github/github-adapter";
import type {
  InboxCacheRepository,
  MaintainerInboxCache,
  MaintainerInboxCacheStore,
} from "../adapters/storage/maintainer-inbox-cache-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { PullRequestSummary } from "../domain/github-context";
import { createReviewId, type IsoTimestamp } from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import {
  projectMaintainerInboxRow,
  type InboxReviewSummary,
  type MaintainerInboxRow,
} from "../domain/maintainer-inbox";
import { ok, type Result } from "../domain/result";
import type {
  WorkspaceProfileConfig,
  WatchedRepoConfig,
} from "../domain/workspace-profile";

export type MaintainerInboxRepository = {
  readonly repo: WatchedRepoConfig;
  readonly state: InboxCacheRepository["state"];
  readonly complete: boolean;
};

export type MaintainerInbox = {
  readonly rows: ReadonlyArray<MaintainerInboxRow>;
  readonly repositories: ReadonlyArray<MaintainerInboxRepository>;
  readonly refreshedAt?: IsoTimestamp;
  readonly dataFreshness: "fresh" | "cached";
  readonly snapshot: {
    readonly state: "current" | "partial" | "failed_cached" | "unavailable";
    readonly refreshedAt?: IsoTimestamp;
  };
  readonly directEntryAvailable: true;
};

export type InboxClock = { readonly now: () => IsoTimestamp };

type SessionReader = Pick<ReviewSessionStore, "listSessions">;
type CacheReader = Pick<MaintainerInboxCacheStore, "read" | "save">;

/** Reads watched repositories concurrently, enriches them with local review state, and falls back to parsed cache data. */
export class MaintainerInboxService {
  constructor(
    private readonly github: GitHubReader,
    private readonly sessions: SessionReader,
    private readonly cache: CacheReader,
    private readonly clock: InboxClock,
  ) {}

  async list(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<MaintainerInbox, never>> {
    const authenticated =
      await this.github.resolveAuthenticatedAccount(profile);
    if (authenticated._tag === "err")
      return await this.cachedOrUnavailable(profile);
    const sessions = await this.sessions.listSessions(profile.id);
    const localSessions = sessions._tag === "ok" ? sessions.value : [];
    const active = profile.repos;
    const results = await mapConcurrent(
      active,
      3,
      async (repo) => await this.readRepository(profile, repo, localSessions),
    );
    const rows = results.flatMap((result) => result.rows).sort(compareRows);
    const repositories = results.map((result) => result.repository);
    const refreshedAt = this.clock.now();
    const complete = results.every((result) => result.repository.complete);
    const dataFreshness = complete ? ("fresh" as const) : ("cached" as const);
    const snapshotState = complete
      ? ("current" as const)
      : ("partial" as const);
    const projectedRows =
      dataFreshness === "fresh" ? rows : rows.map(toCachedRow);
    const value: MaintainerInbox = {
      rows: projectedRows,
      repositories,
      refreshedAt,
      dataFreshness,
      snapshot: { state: snapshotState, refreshedAt },
      directEntryAvailable: true,
    };
    const cached: MaintainerInboxCache = {
      schemaVersion: 1,
      refreshedAt,
      rows,
      repositories: repositories.map(({ repo, state, complete }) => ({
        identity: { host: repo.host, owner: repo.owner, repo: repo.repo },
        state,
        complete,
      })),
    };
    if (complete) await this.cache.save(profile.id, cached);
    return ok(value);
  }

  private async readRepository(
    profile: WorkspaceProfileConfig,
    repo: WatchedRepoConfig,
    sessions: ReadonlyArray<ReviewSession>,
  ): Promise<{
    readonly rows: ReadonlyArray<MaintainerInboxRow>;
    readonly repository: MaintainerInboxRepository;
  }> {
    const listed = await this.github.listMaintainerPullRequests({
      profile,
      repo: {
        host: repo.host,
        owner: repo.owner,
        repo: repo.repo,
        number: 1 as never,
      },
    });
    if (listed._tag === "err")
      return {
        rows: [],
        repository: {
          repo,
          state:
            listed.error._tag === "GitHubAuthenticationFailed"
              ? "github_auth"
              : "github_read",
          complete: false,
        },
      };
    const rows = await Promise.all(
      listed.value.pullRequests.map(async ({ summary, checks }) => {
        const latestReview = latestReviewFor(summary, sessions);
        return projectMaintainerInboxRow({
          summary,
          checks,
          activeAccount: profile.ghAccount,
          ...(latestReview === undefined ? {} : { latestReview }),
          dataFreshness: "fresh",
        });
      }),
    );
    return {
      rows,
      repository: {
        repo,
        state: listed.value.pullRequests.length === 0 ? "no_open_prs" : "ready",
        complete: listed.value.complete,
      },
    };
  }

  private async cachedOrUnavailable(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<MaintainerInbox, never>> {
    const cached = await this.cache.read(profile.id);
    if (cached._tag === "ok")
      return ok({
        rows: cached.value.rows.map(toCachedRow),
        repositories: profile.repos.map((repo) => ({
          repo,
          state:
            cached.value.repositories.find(
              (entry) =>
                entry.identity.host === repo.host &&
                entry.identity.owner === repo.owner &&
                entry.identity.repo === repo.repo,
            )?.state ?? "github_auth",
          complete: false,
        })),
        refreshedAt: cached.value.refreshedAt as IsoTimestamp,
        dataFreshness: "cached",
        snapshot: {
          state: "failed_cached",
          refreshedAt: cached.value.refreshedAt as IsoTimestamp,
        },
        directEntryAvailable: true,
      });
    return ok({
      rows: [],
      repositories: profile.repos.map((repo) => ({
        repo,
        state: "github_auth",
        complete: false,
      })),
      dataFreshness: "cached",
      snapshot: { state: "unavailable" },
      directEntryAvailable: true,
    });
  }
}

function latestReviewFor(
  summary: PullRequestSummary,
  sessions: ReadonlyArray<ReviewSession>,
): InboxReviewSummary | undefined {
  const session = sessions.find(
    (candidate) =>
      candidate.key.host === summary.ref.host &&
      candidate.key.owner === summary.ref.owner &&
      candidate.key.repo === summary.ref.repo &&
      candidate.key.prNumber === summary.ref.number,
  );
  if (session === undefined) return undefined;
  return {
    reviewId: createReviewId({
      profileId: session.key.profileId,
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      prNumber: session.key.prNumber,
    }),
    reviewedHeadSha: session.key.headSha,
    updatedAt: session.updatedAt,
    matchesCurrentHead: session.key.headSha === summary.headSha,
  };
}

function toCachedRow(row: MaintainerInboxRow): MaintainerInboxRow {
  return {
    ...row,
    dataFreshness: "cached",
    recommendedAction:
      row.recommendedAction.kind === "open_merge_readiness"
        ? { kind: "run_review", label: "Run review" }
        : row.recommendedAction,
  };
}

function compareRows(
  left: MaintainerInboxRow,
  right: MaintainerInboxRow,
): number {
  const priority = (row: MaintainerInboxRow): number =>
    row.categories.includes("saved_review")
      ? 0
      : row.categories.includes("updated_since_review")
        ? 1
        : row.categories.includes("needs_review")
          ? 2
          : row.categories.includes("waiting_for_author")
            ? 3
            : row.categories.includes("checks_failing")
              ? 4
              : row.categories.includes("ready_to_merge")
                ? 5
                : 6;
  return (
    priority(left) - priority(right) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.title.localeCompare(right.title)
  );
}

async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const values: Array<R> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) return;
        values[index] = await map(item);
      }
    }),
  );
  return values;
}
