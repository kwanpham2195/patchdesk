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
// `list()` extracts `filter.state` once into a plain `InboxScope` and
// normalizes `filter.labels` once into a sorted, deduplicated label list
// (`normalizeInboxLabels`), then threads both through everywhere the
// pre-slice-6 code already took a bare `scope: InboxScope` —
// `readRepository`, `cachedOrUnavailable`, `unavailablePage`, and
// `buildInboxSearchQuery`. `cachedOrUnavailable` and `unavailablePage` stay
// label-blind on purpose: a cached or unavailable read has no live query to
// filter, so it always serves (or reports) every cached row regardless of
// the requested label filter.
import type { PullRequestRef } from "../domain/pull-request";
import type { ReviewSession } from "../domain/review-session";
import { ok, type Result } from "../domain/result";
import type {
  WorkspaceProfileConfig,
  WatchedRepoConfig,
} from "../domain/workspace-profile";
import { isInboxCacheStale } from "../domain/inbox-freshness-policy";

const MAX_PAGE_TOKEN_LENGTH = 16_384;
const MAX_REPOSITORY_CURSOR_LENGTH = 4_096;

/** One watched repository, identified without any of the maintainer's local checkout details. */
export type InboxRepositoryRef = Pick<
  PullRequestRef,
  "host" | "owner" | "repo"
>;

const inboxPageTokenSchema = v.strictObject({
  scope: v.picklist(["open", "merged"]),
  page: v.pipe(v.number(), v.integer(), v.minValue(2)),
  /** The page size the token's cursor was cut at; a mismatched request is rejected as malformed. */
  size: v.picklist(INBOX_PAGE_SIZES),
  /** The repository the token was minted for; a request for a different repository is rejected as malformed. */
  repository: v.strictObject({
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
  }),
  /** The (sorted) label filter the token's cursor was cut under; a request
   * whose label filter has changed is rejected the same way a repository
   * change is — the cursor belongs to a different search query. */
  labels: v.array(v.string()),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_REPOSITORY_CURSOR_LENGTH),
    ),
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
  /**
   * GitHub's true repository-wide match count for the current scope's
   * search filter (`issueCount`), not this page's loaded row count. Present
   * only when the repository was just freshly read through the
   * search-backed query; absent for cached, unavailable, or failed reads.
   */
  readonly matchCount?: number;
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
/** A supplied opaque inbox page token is malformed or does not match the requested repository. */
export type InboxPageRequestFailure = "invalid_page";

type SessionReader = Pick<ReviewSessionStore, "listSessions">;
type CacheReader = Pick<MaintainerInboxCacheStore, "read" | "save">;
type RepositoryRead = {
  readonly entries: ReadonlyArray<{
    readonly cursor: string;
    readonly row: MaintainerInboxRow;
  }>;
  readonly hasNextPage: boolean;
  /** Advances an empty GraphQL page without skipping a non-emitted inbox row. */
  readonly emptyPageEndCursor?: string;
  readonly repository: MaintainerInboxRepository;
  /** GitHub's `issueCount` for the search query just read; absent on a failed read. */
  readonly issueCount?: number;
};

/** Reads one Selected repository's maintainer inbox page and keeps its GitHub cursor inside an opaque token. */
export class MaintainerInboxService {
  constructor(
    private readonly github: GitHubReader,
    private readonly sessions: SessionReader,
    private readonly cache: CacheReader,
    private readonly clock: InboxClock,
  ) {}

  async list(
    profile: WorkspaceProfileConfig,
    repository: InboxRepositoryRef,
    request: InboxPageRequest = {
      filter: { state: "open" },
      pageSize: DEFAULT_INBOX_PAGE_SIZE,
    },
  ): Promise<Result<MaintainerInbox, InboxPageRequestFailure>> {
    const scope = request.filter.state;
    const labels = normalizeInboxLabels(request.filter.labels);
    const pageToken = decodeInboxPageToken(request, repository, scope, labels);
    if (pageToken === undefined) return { _tag: "err", error: "invalid_page" };
    const authenticated =
      await this.github.resolveAuthenticatedAccount(profile);
    if (authenticated._tag === "err")
      return request.pageToken === undefined
        ? await this.cachedOrUnavailable(
            profile,
            repository,
            scope,
            request.pageSize,
          )
        : this.unavailablePage(repository, scope, request.pageSize);

    const sessions = await this.sessions.listSessions(profile.id);
    const localSessions = sessions._tag === "ok" ? sessions.value : [];
    const read = await this.readRepository(
      profile,
      repository,
      scope,
      labels,
      request.pageSize,
      pageToken.cursor,
      localSessions,
    );
    const visible = read.entries.slice(0, request.pageSize);
    const hasNextPage =
      read.entries.length > visible.length || read.hasNextPage;
    const complete = !hasNextPage && read.repository.complete;
    const dataFreshness: "fresh" | "cached" =
      read.repository.state === "ready" ||
      read.repository.state === "no_open_prs"
        ? "fresh"
        : "cached";
    const refreshedAt = this.clock.now();
    const cursor =
      visible.at(-1)?.cursor ?? read.emptyPageEndCursor ?? pageToken.cursor;
    const baseNextToken = {
      scope,
      page: pageToken.page + 1,
      size: request.pageSize,
      repository: {
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
      },
      labels,
    };
    const nextPageToken = hasNextPage
      ? encodeInboxPageToken(
          cursor === undefined ? baseNextToken : { ...baseNextToken, cursor },
        )
      : undefined;
    const matchCountField =
      read.issueCount === undefined ? {} : { matchCount: read.issueCount };
    const value: MaintainerInbox = {
      scope,
      pageSize: request.pageSize,
      rows:
        dataFreshness === "fresh"
          ? visible.map((entry) => entry.row)
          : visible.map((entry) => toCachedRow(entry.row)),
      repositories: [read.repository],
      refreshedAt,
      dataFreshness,
      snapshot: { state: complete ? "current" : "partial", refreshedAt },
      ...matchCountField,
    };
    if (
      scope === "open" &&
      request.pageToken === undefined &&
      complete &&
      dataFreshness === "fresh"
    ) {
      const cached: MaintainerInboxCache = {
        schemaVersion: 1,
        refreshedAt,
        rows: visible.map((entry) => entry.row),
        repository: {
          identity: {
            host: repository.host,
            owner: repository.owner,
            repo: repository.repo,
          },
          state: read.repository.state,
          complete: read.repository.complete,
        },
      };
      await this.cache.save(profile.id, repository, cached);
    }
    return ok(
      nextPageToken === undefined ? value : { ...value, nextPageToken },
    );
  }

  private async readRepository(
    profile: WorkspaceProfileConfig,
    repository: InboxRepositoryRef,
    scope: InboxScope,
    labels: ReadonlyArray<string>,
    pageSize: InboxPageSize,
    cursor: string | undefined,
    sessions: ReadonlyArray<ReviewSession>,
  ): Promise<RepositoryRead> {
    const repo = {
      host: repository.host,
      owner: repository.owner,
      repo: repository.repo,
    };
    const searchQuery = buildInboxSearchQuery(repo, scope, labels);
    const searched = await this.github.searchMaintainerPullRequests(
      cursor === undefined
        ? { profile, repo, searchQuery, scope, pageSize }
        : { profile, repo, searchQuery, scope, pageSize, cursor },
    );
    if (searched._tag === "err")
      return failedRepositoryRead(repo, searched.error);
    const entries = searched.value.entries.map(
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
        return { cursor: entryCursor, row };
      },
    );
    const emptyPageEndCursor =
      entries.length === 0 && searched.value.hasNextPage
        ? searched.value.endCursor
        : undefined;
    const read: RepositoryRead = {
      entries,
      hasNextPage: searched.value.hasNextPage,
      issueCount: searched.value.issueCount,
      repository: {
        repo,
        state: entries.length === 0 ? "no_open_prs" : "ready",
        complete: !searched.value.hasNextPage,
      },
    };
    return emptyPageEndCursor === undefined
      ? read
      : { ...read, emptyPageEndCursor };
  }

  private async cachedOrUnavailable(
    profile: WorkspaceProfileConfig,
    repository: InboxRepositoryRef,
    scope: InboxScope,
    pageSize: InboxPageSize,
  ): Promise<Result<MaintainerInbox, never>> {
    if (scope === "merged")
      return this.unavailablePage(repository, scope, pageSize);
    const cached = await this.cache.read(profile.id, repository);
    if (cached._tag === "ok") {
      const refreshedAt = parseIsoTimestamp(cached.value.refreshedAt);
      if (refreshedAt._tag === "err")
        return this.unavailablePage(repository, scope, pageSize);
      const snapshotState = isInboxCacheStale(
        Date.parse(this.clock.now()) - Date.parse(refreshedAt.value),
      )
        ? "stale_cached"
        : "failed_cached";
      return ok({
        scope,
        pageSize,
        rows: cached.value.rows.map(toCachedRow),
        repositories: [
          {
            repo: {
              host: repository.host,
              owner: repository.owner,
              repo: repository.repo,
            },
            state: cached.value.repository.state,
            complete: false,
          },
        ],
        refreshedAt: refreshedAt.value,
        dataFreshness: "cached",
        snapshot: {
          state: snapshotState,
          refreshedAt: refreshedAt.value,
        },
      });
    }
    return this.unavailablePage(repository, scope, pageSize);
  }

  private unavailablePage(
    repository: InboxRepositoryRef,
    scope: InboxScope,
    pageSize: InboxPageSize,
  ): Result<MaintainerInbox, never> {
    return ok({
      scope,
      pageSize,
      rows: [],
      repositories: [
        {
          repo: {
            host: repository.host,
            owner: repository.owner,
            repo: repository.repo,
          },
          state: "github_auth",
          complete: false,
        },
      ],
      dataFreshness: "cached",
      snapshot: { state: "unavailable" },
    });
  }
}

/**
 * Builds the GitHub search qualifier string for one repository, scope, and
 * label filter: `repo:OWNER/NAME is:pr is:open label:"NAME"`. The sole place
 * that builds this string, so every renderer-chosen filter extends it here
 * rather than through ad hoc concatenation elsewhere — and so GitHub's
 * 256-character search cap has one place to be enforced. `labels` is trusted
 * here: the route already bounds its count, length, and character set
 * (see `parseInboxLabelsQuery` in `local-api.ts`) before it reaches this
 * function, so a label name can never contain the quote it is wrapped in.
 */
function buildInboxSearchQuery(
  repo: InboxRepositoryRef,
  scope: InboxScope,
  labels: ReadonlyArray<string>,
): string {
  const state = scope === "merged" ? "is:merged" : "is:open";
  const labelQualifiers = labels.map((label) => `label:"${label}"`).join(" ");
  const base = `repo:${repo.owner}/${repo.repo} is:pr ${state}`;
  return labelQualifiers.length === 0 ? base : `${base} ${labelQualifiers}`;
}

/** Sorted, deduplicated label filter — the canonical form compared against
 * a decoded page token's own `labels`. Returns a mutable `string[]` (rather
 * than `ReadonlyArray<string>`) because `InboxPageToken`'s `labels` field,
 * inferred from `inboxPageTokenSchema`'s `v.array(v.string())`, is itself
 * mutable — matching it here avoids a readonly-to-mutable cast at every
 * call site that builds or compares a token. */
function normalizeInboxLabels(
  labels: ReadonlyArray<string> | undefined,
): string[] {
  return [...new Set(labels ?? [])].sort();
}
function sameLabels(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length && left.every((label, i) => label === right[i])
  );
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
  repository: InboxRepositoryRef,
  scope: InboxScope,
  labels: string[],
): InboxPageToken | undefined {
  if (request.pageToken === undefined)
    return {
      scope,
      page: 1,
      size: request.pageSize,
      repository: {
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
      },
      labels,
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
      value.scope !== scope ||
      value.size !== request.pageSize ||
      !sameRepository(value.repository, repository) ||
      !sameLabels(value.labels, labels)
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function encodeInboxPageToken(token: InboxPageToken): string {
  return Buffer.from(JSON.stringify(token)).toString("base64url");
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
