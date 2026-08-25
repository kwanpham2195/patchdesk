import * as v from "valibot";

import type { ForbiddenReason } from "../adapters/github/command-runner";
import type { GitHubReader } from "../adapters/github/github-adapter";
import type {
  InboxCacheRepository,
  MaintainerInboxCache,
  MaintainerInboxCacheStore,
} from "../adapters/storage/maintainer-inbox-cache-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { PullRequestSummary } from "../domain/github-context";
import {
  createReviewId,
  parseIsoTimestamp,
  type IsoTimestamp,
} from "../domain/ids";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_PAGE_SIZES,
  type InboxPageRequest,
  type InboxPageSize,
  type InboxScope,
  projectMaintainerInboxRow,
  type InboxReviewSummary,
  type MaintainerInboxRow,
} from "../domain/maintainer-inbox";
import type { ReviewSession } from "../domain/review-session";
import { ok, type Result } from "../domain/result";
import type {
  WorkspaceProfileConfig,
  WatchedRepoConfig,
} from "../domain/workspace-profile";
import { isInboxCacheStale } from "../domain/inbox-freshness-policy";

const MAX_PAGE_TOKEN_LENGTH = 16_384;
const MAX_REPOSITORY_CURSOR_LENGTH = 4_096;

const inboxPageTokenSchema = v.strictObject({
  scope: v.picklist(["open", "merged"]),
  page: v.pipe(v.number(), v.integer(), v.minValue(2)),
  /** The page size the token's cursors were cut at; a mismatched request is rejected as malformed. */
  size: v.picklist(INBOX_PAGE_SIZES),
  repositories: v.array(
    v.strictObject({
      host: v.string(),
      owner: v.string(),
      repo: v.string(),
      cursor: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_REPOSITORY_CURSOR_LENGTH),
        ),
      ),
    }),
  ),
});

type InboxPageToken = v.InferOutput<typeof inboxPageTokenSchema>;

export type MaintainerInboxRepository = {
  readonly repo: WatchedRepoConfig;
  readonly state: InboxCacheRepository["state"];
  readonly complete: boolean;
  readonly resumeAt?: IsoTimestamp;
  readonly forbiddenReason?: ForbiddenReason;
};

export type MaintainerInbox = {
  readonly scope: InboxScope;
  readonly pageSize: InboxPageSize;
  readonly nextPageToken?: string;
  readonly rows: ReadonlyArray<MaintainerInboxRow>;
  readonly repositories: ReadonlyArray<MaintainerInboxRepository>;
  readonly refreshedAt?: IsoTimestamp;
  readonly dataFreshness: "fresh" | "cached";
  readonly snapshot: {
    readonly state:
      | "current"
      | "partial"
      | "failed_cached"
      | "stale_cached"
      | "unavailable";
    readonly refreshedAt?: IsoTimestamp;
  };
};

export type InboxClock = { readonly now: () => IsoTimestamp };
/** A supplied opaque inbox page token is malformed or does not match the active profile. */
export type InboxPageRequestFailure = "invalid_page";

type SessionReader = Pick<ReviewSessionStore, "listSessions">;
type CacheReader = Pick<MaintainerInboxCacheStore, "read" | "save">;
type RepositoryRead = {
  readonly entries: ReadonlyArray<{
    readonly cursor: string;
    readonly row: MaintainerInboxRow;
    readonly repo: WatchedRepoConfig;
  }>;
  readonly hasNextPage: boolean;
  /** Advances an empty GraphQL page without skipping a non-emitted inbox row. */
  readonly emptyPageEndCursor?: string;
  readonly repository: MaintainerInboxRepository;
};

/** Reads one globally ordered maintainer inbox page and keeps GitHub cursors inside an opaque token. */
export class MaintainerInboxService {
  constructor(
    private readonly github: GitHubReader,
    private readonly sessions: SessionReader,
    private readonly cache: CacheReader,
    private readonly clock: InboxClock,
  ) {}

  async list(
    profile: WorkspaceProfileConfig,
    request: InboxPageRequest = {
      scope: "open",
      pageSize: DEFAULT_INBOX_PAGE_SIZE,
    },
  ): Promise<Result<MaintainerInbox, InboxPageRequestFailure>> {
    const pageToken = decodeInboxPageToken(request, profile);
    if (pageToken === undefined) return { _tag: "err", error: "invalid_page" };
    const authenticated =
      await this.github.resolveAuthenticatedAccount(profile);
    if (authenticated._tag === "err")
      return request.pageToken === undefined
        ? await this.cachedOrUnavailable(
            profile,
            request.scope,
            request.pageSize,
          )
        : this.unavailablePage(profile, request.scope, request.pageSize);

    const sessions = await this.sessions.listSessions(profile.id);
    const localSessions = sessions._tag === "ok" ? sessions.value : [];
    const reads = await mapConcurrent(
      profile.repos,
      3,
      async (repo) =>
        await this.readRepository(
          profile,
          repo,
          request.scope,
          request.pageSize,
          cursorForRepository(pageToken, repo),
          localSessions,
        ),
    );
    const entries = reads.flatMap((read) => read.entries).sort(compareEntries);
    const visible = entries.slice(0, request.pageSize);
    const repositories = reads.map((read) => read.repository);
    const visibleEntries = new Set(visible);
    const hasNextPage = reads.some(
      (read) =>
        read.entries.some((entry) => !visibleEntries.has(entry)) ||
        read.hasNextPage,
    );
    const complete =
      !hasNextPage && repositories.every((repo) => repo.complete);
    const dataFreshness = repositories.every(
      (repo) => repo.state === "ready" || repo.state === "no_open_prs",
    )
      ? "fresh"
      : "cached";
    const refreshedAt = this.clock.now();
    const nextPageToken = hasNextPage
      ? encodeInboxPageToken({
          scope: request.scope,
          page: pageToken.page + 1,
          size: request.pageSize,
          repositories: profile.repos.map((repo) => {
            const emitted = visible
              .filter((entry) => sameRepository(entry.repo, repo))
              .at(-1);
            const read = reads.find((candidate) =>
              sameRepository(candidate.repository.repo, repo),
            );
            const cursor =
              emitted?.cursor ??
              read?.emptyPageEndCursor ??
              cursorForRepository(pageToken, repo);
            return cursor === undefined
              ? { host: repo.host, owner: repo.owner, repo: repo.repo }
              : { host: repo.host, owner: repo.owner, repo: repo.repo, cursor };
          }),
        })
      : undefined;
    const value: MaintainerInbox = {
      scope: request.scope,
      pageSize: request.pageSize,
      rows:
        dataFreshness === "fresh"
          ? visible.map((entry) => entry.row)
          : visible.map((entry) => toCachedRow(entry.row)),
      repositories,
      refreshedAt,
      dataFreshness,
      snapshot: { state: complete ? "current" : "partial", refreshedAt },
    };
    if (
      request.scope === "open" &&
      request.pageToken === undefined &&
      complete &&
      dataFreshness === "fresh"
    ) {
      const cached: MaintainerInboxCache = {
        schemaVersion: 1,
        refreshedAt,
        rows: visible.map((entry) => entry.row),
        repositories: repositories.map(({ repo, state, complete }) => ({
          identity: { host: repo.host, owner: repo.owner, repo: repo.repo },
          state,
          complete,
        })),
      };
      await this.cache.save(profile.id, cached);
    }
    return ok(
      nextPageToken === undefined ? value : { ...value, nextPageToken },
    );
  }

  private async readRepository(
    profile: WorkspaceProfileConfig,
    repo: WatchedRepoConfig,
    scope: InboxScope,
    pageSize: InboxPageSize,
    cursor: string | undefined,
    sessions: ReadonlyArray<ReviewSession>,
  ): Promise<RepositoryRead> {
    const repository = { host: repo.host, owner: repo.owner, repo: repo.repo };
    const listed = await this.github.listMaintainerPullRequests(
      cursor === undefined
        ? { profile, repo: repository, scope, pageSize }
        : { profile, repo: repository, scope, pageSize, cursor },
    );
    if (listed._tag === "err") return failedRepositoryRead(repo, listed.error);
    const entries = listed.value.entries.map(
      ({ cursor: entryCursor, pullRequest }) => {
        const latestReview = latestReviewFor(pullRequest.summary, sessions);
        const input = {
          summary: pullRequest.summary,
          checks: pullRequest.checks,
          activeAccount: profile.ghAccount,
          dataFreshness: "fresh" as const,
        };
        const row =
          latestReview === undefined
            ? projectMaintainerInboxRow(input)
            : projectMaintainerInboxRow({ ...input, latestReview });
        return { cursor: entryCursor, row, repo };
      },
    );
    const emptyPageEndCursor =
      entries.length === 0 && listed.value.hasNextPage
        ? listed.value.endCursor
        : undefined;
    const read: RepositoryRead = {
      entries,
      hasNextPage: listed.value.hasNextPage,
      repository: {
        repo,
        state: entries.length === 0 ? "no_open_prs" : "ready",
        complete: !listed.value.hasNextPage,
      },
    };
    return emptyPageEndCursor === undefined
      ? read
      : { ...read, emptyPageEndCursor };
  }

  private async cachedOrUnavailable(
    profile: WorkspaceProfileConfig,
    scope: InboxScope,
    pageSize: InboxPageSize,
  ): Promise<Result<MaintainerInbox, never>> {
    if (scope === "merged")
      return this.unavailablePage(profile, scope, pageSize);
    const cached = await this.cache.read(profile.id);
    if (cached._tag === "ok") {
      const refreshedAt = parseIsoTimestamp(cached.value.refreshedAt);
      if (refreshedAt._tag === "err")
        return this.unavailablePage(profile, scope, pageSize);
      const snapshotState = isInboxCacheStale(
        Date.parse(this.clock.now()) - Date.parse(refreshedAt.value),
      )
        ? "stale_cached"
        : "failed_cached";
      return ok({
        scope,
        pageSize,
        rows: cached.value.rows.map(toCachedRow),
        repositories: profile.repos.map((repo) => ({
          repo,
          state:
            cached.value.repositories.find((entry) =>
              sameRepository(entry.identity, repo),
            )?.state ?? "github_auth",
          complete: false,
        })),
        refreshedAt: refreshedAt.value,
        dataFreshness: "cached",
        snapshot: {
          state: snapshotState,
          refreshedAt: refreshedAt.value,
        },
      });
    }
    return this.unavailablePage(profile, scope, pageSize);
  }

  private unavailablePage(
    profile: WorkspaceProfileConfig,
    scope: InboxScope,
    pageSize: InboxPageSize,
  ): Result<MaintainerInbox, never> {
    return ok({
      scope,
      pageSize,
      rows: [],
      repositories: profile.repos.map((repo) => ({
        repo,
        state: "github_auth",
        complete: false,
      })),
      dataFreshness: "cached",
      snapshot: { state: "unavailable" },
    });
  }
}

function failedRepositoryRead(
  repo: WatchedRepoConfig,
  error: {
    readonly _tag: string;
    readonly resumeAt?: IsoTimestamp;
    readonly reason?: ForbiddenReason;
  },
): RepositoryRead {
  const state =
    error._tag === "GitHubAuthenticationFailed"
      ? "github_auth"
      : error._tag === "GitHubRateLimited"
        ? "github_rate_limited"
        : error._tag === "GitHubForbidden"
          ? "github_forbidden"
          : "github_read";
  const base = {
    entries: [],
    hasNextPage: false,
  };
  if (error.resumeAt === undefined) {
    if (error.reason === undefined)
      return { ...base, repository: { repo, state, complete: false } };
    return {
      ...base,
      repository: {
        repo,
        state,
        complete: false,
        forbiddenReason: error.reason,
      },
    };
  }
  if (error.reason === undefined)
    return {
      ...base,
      repository: { repo, state, complete: false, resumeAt: error.resumeAt },
    };
  return {
    ...base,
    repository: {
      repo,
      state,
      complete: false,
      resumeAt: error.resumeAt,
      forbiddenReason: error.reason,
    },
  };
}

function decodeInboxPageToken(
  request: InboxPageRequest,
  profile: WorkspaceProfileConfig,
): InboxPageToken | undefined {
  if (request.scope !== "open" && request.scope !== "merged") return undefined;
  if (request.pageToken === undefined)
    return {
      scope: request.scope,
      page: 1,
      size: request.pageSize,
      repositories: profile.repos.map((repo) => ({
        host: repo.host,
        owner: repo.owner,
        repo: repo.repo,
      })),
    };
  if (request.pageToken.length > MAX_PAGE_TOKEN_LENGTH) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(request.pageToken, "base64url").toString("utf8"),
    );
    const parsed = v.safeParse(inboxPageTokenSchema, decoded);
    if (!parsed.success) return undefined;
    const value = parsed.output;
    if (
      value.scope !== request.scope ||
      value.size !== request.pageSize ||
      value.repositories.length !== profile.repos.length
    )
      return undefined;
    if (
      !profile.repos.every((repo) =>
        value.repositories.some((entry) => sameRepository(entry, repo)),
      )
    )
      return undefined;
    return {
      scope: request.scope,
      page: value.page,
      size: value.size,
      repositories: value.repositories,
    };
  } catch {
    return undefined;
  }
}

function encodeInboxPageToken(token: InboxPageToken): string {
  return Buffer.from(JSON.stringify(token)).toString("base64url");
}
function cursorForRepository(
  token: InboxPageToken,
  repo: WatchedRepoConfig,
): string | undefined {
  return token.repositories.find((entry) => sameRepository(entry, repo))
    ?.cursor;
}
function sameRepository(
  left: {
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
  },
  right: {
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
  },
): boolean {
  return (
    left.host === right.host &&
    left.owner === right.owner &&
    left.repo === right.repo
  );
}
function compareEntries(
  left: RepositoryRead["entries"][number],
  right: RepositoryRead["entries"][number],
): number {
  return (
    right.row.updatedAt.localeCompare(left.row.updatedAt) ||
    left.repo.host.localeCompare(right.repo.host) ||
    left.repo.owner.localeCompare(right.repo.owner) ||
    left.repo.repo.localeCompare(right.repo.repo) ||
    left.row.identity.number - right.row.identity.number
  );
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
  return session === undefined
    ? undefined
    : {
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
async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const values: Array<R> = [];
  let next = 0;
  function processNext(): Promise<void> {
    const index = next++;
    const item = items[index];
    if (item === undefined) return Promise.resolve();
    return map(item).then((value) => {
      values[index] = value;
      return processNext();
    });
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, processNext),
  );
  return values;
}
