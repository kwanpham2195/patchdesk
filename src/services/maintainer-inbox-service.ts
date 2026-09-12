import { readFile } from "node:fs/promises";

import * as v from "valibot";

import type { ForbiddenReason } from "../adapters/github/command-runner";
import type { GitHubReader } from "../adapters/github/github-adapter";
import type {
  InboxCacheRepository,
  MaintainerInboxCache,
  MaintainerInboxCacheStore,
} from "../adapters/storage/maintainer-inbox-cache-store";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { StorageFailure } from "../adapters/storage/json-file";
import { resolveAvatarDataUris } from "../adapters/storage/avatar-cache-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { changeScopeFromPatch, type ChangeScope } from "../domain/change-scope";
import { definedProps } from "../domain/defined-props";
import type { PullRequestSummary } from "../domain/github-context";
import type { InsightRecord, InsightRevision } from "../domain/insight-record";
import {
  createReviewId,
  parseIsoTimestamp,
  type IsoTimestamp,
  type WorkspaceProfileId,
} from "../domain/ids";
import {
  composeInboxSearchQuery,
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_CHECK_STATUS_FILTER_VALUES,
  INBOX_PAGE_SIZES,
  INBOX_REVIEW_STATE_FILTER_VALUES,
  parseInboxAuthorFilter,
  parseInboxBaseBranchFilter,
  type InboxFilter,
  type InboxPageRequest,
  type InboxPageSize,
  INBOX_STATE_FILTER_VALUES,
  type InboxStateFilter,
  projectMaintainerInboxRow,
  type InboxInsightReadiness,
  type InboxInsightState,
  type InboxReviewSummary,
  type MaintainerInboxRow,
  type InboxDataFreshness,
  type InboxSnapshotState,
} from "../domain/maintainer-inbox";
import type { PullRequestRef } from "../domain/pull-request";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import { parseStoredBrief } from "../domain/stored-brief";
import type { ReviewSession } from "../domain/review-session";
import { ok, type Result } from "../domain/result";
import type {
  WorkspaceProfileConfig,
  WatchedRepoConfig,
} from "../domain/workspace-profile";
import type { AvatarRailDependencies } from "./avatar-sync-service";
import { isInboxCacheStale } from "../domain/inbox-freshness-policy";

const MAX_PAGE_TOKEN_LENGTH = 16_384;
const MAX_REPOSITORY_CURSOR_LENGTH = 4_096;

/** One watched repository, identified without any of the maintainer's local
 * checkout details. Branded, because the main process is the side that parses
 * GitHub identifiers; the renderer's plain-string counterpart is
 * `RepositoryIdentity`. Structurally the same as `WatchedRepoRef` in
 * `profile-service.ts` — see the note in `repository-identity.ts`. */
export type InboxRepositoryRef = Pick<
  PullRequestRef,
  "host" | "owner" | "repo"
>;

const inboxPageTokenSchema = v.strictObject({
  state: v.picklist(INBOX_STATE_FILTER_VALUES),
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
  /** The "Awaiting review from you" preset the token's cursor was cut under;
   * like a label change, flipping it is a different search query, so the
   * cursor no longer belongs to it. */
  awaitingMyReview: v.boolean(),
  /** The review-state qualifier the token's cursor was cut under. */
  reviewState: v.optional(v.picklist(INBOX_REVIEW_STATE_FILTER_VALUES)),
  /** The check-status qualifier the token's cursor was cut under. */
  checkStatus: v.optional(v.picklist(INBOX_CHECK_STATUS_FILTER_VALUES)),
  /** The author qualifier the token's cursor was cut under; run through the
   * domain parser here as well as at the route, because a token is
   * renderer-supplied input. */
  author: v.optional(
    v.pipe(
      v.string(),
      v.check((value) => parseInboxAuthorFilter(value)._tag === "ok"),
    ),
  ),
  /** The base-branch qualifier the token's cursor was cut under. */
  baseBranch: v.optional(
    v.pipe(
      v.string(),
      v.check((value) => parseInboxBaseBranchFilter(value)._tag === "ok"),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_REPOSITORY_CURSOR_LENGTH),
    ),
  ),
});

type InboxPageToken = v.InferOutput<typeof inboxPageTokenSchema>;

/** The request's own filter with the two fields a page token compares
 * exactly: `labels` in the canonical sorted, deduplicated form and
 * `awaitingMyReview` resolved, so the token a page is cut with and the token
 * the next request presents are built from the same values. */
type NormalizedInboxFilter = Omit<
  InboxFilter,
  "labels" | "awaitingMyReview"
> & {
  readonly labels: string[];
  readonly awaitingMyReview: boolean;
};

/** What a supplied page token is matched against, and what the first page's own token is minted from. */
type InboxPageTokenInput = {
  readonly repository: InboxRepositoryRef;
  readonly filter: NormalizedInboxFilter;
  readonly pageSize: InboxPageSize;
  readonly pageToken: string | undefined;
};

type MaintainerInboxRepository = {
  readonly repo: WatchedRepoConfig;
  readonly state: InboxCacheRepository["state"];
  readonly complete: boolean;
  readonly resumeAt?: IsoTimestamp;
  readonly forbiddenReason?: ForbiddenReason;
};

export type MaintainerInbox = {
  readonly state: InboxStateFilter;
  readonly pageSize: InboxPageSize;
  readonly nextPageToken?: string;
  readonly rows: ReadonlyArray<MaintainerInboxRow>;
  readonly repositories: ReadonlyArray<MaintainerInboxRepository>;
  readonly refreshedAt?: IsoTimestamp;
  readonly dataFreshness: InboxDataFreshness;
  /**
   * GitHub's true repository-wide match count for the current state's
   * search filter (`issueCount`), not this page's loaded row count. Present
   * only when the repository was just freshly read through the
   * search-backed query; absent for cached, unavailable, or failed reads.
   */
  readonly matchCount?: number;
  readonly snapshot: {
    readonly state: InboxSnapshotState;
    readonly refreshedAt?: IsoTimestamp;
  };
};

export type InboxClock = { readonly now: () => IsoTimestamp };
/** A supplied opaque inbox page token is malformed or does not match the requested repository. */
export type InboxPageRequestFailure = "invalid_page";

type SessionReader = Pick<ReviewSessionStore, "listSessions">;
type CacheReader = Pick<MaintainerInboxCacheStore, "read" | "save">;
/**
 * The Insight reads the inbox makes: which kinds are retained for this row.
 * `loadTyped` is here for the Brief alone -- see `readInsightReadiness`.
 */
type InboxInsightReader = Pick<InsightStore, "load" | "loadTyped">;
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

/** One repository's page read: the filter and page to search under, plus the sessions each row's Review evidence is projected from. */
type InboxRepositoryReadInput = {
  readonly profile: WorkspaceProfileConfig;
  readonly repository: InboxRepositoryRef;
  readonly filter: NormalizedInboxFilter;
  readonly pageSize: InboxPageSize;
  readonly cursor: string | undefined;
  readonly sessions: ReadonlyArray<ReviewSession>;
};

/** Reads one Selected repository's maintainer inbox page and keeps its GitHub cursor inside an opaque token. */
export class MaintainerInboxService {
  constructor(
    private readonly github: GitHubReader,
    private readonly sessions: SessionReader,
    private readonly cache: CacheReader,
    private readonly clock: InboxClock,
    /**
     * Optional, like the coordinator's `remotes`: without it a row simply
     * carries no `insights`, and every existing caller keeps its four
     * collaborators.
     */
    private readonly insights?: InboxInsightReader,
    /**
     * Optional in the same way `insights` is: without it a row simply carries
     * no `authorAvatarDataUri` and the renderer draws the initials badge.
     */
    private readonly avatars?: AvatarRailDependencies,
  ) {}

  /**
   * Attaches each row's cached author avatar as a `data:` URI: warms the
   * shared per-profile avatar cache and then resolves, in the same request,
   * so the rows returned already carry every avatar the warm pass fetched.
   * `warmAvatarUrls` skips URLs already on disk, so a repeat listing costs
   * nothing; anything past its per-sync cap stays initials until a later
   * read.
   *
   * Wrapped whole in a try/catch for the same reason
   * `AssigneeService.withResolvedAvatars` is: an avatar is decorative, so a
   * misbehaving avatar dependency must never fail an inbox read.
   */
  private async withResolvedAuthorAvatars(
    profileId: WorkspaceProfileId,
    rows: ReadonlyArray<MaintainerInboxRow>,
  ): Promise<ReadonlyArray<MaintainerInboxRow>> {
    const avatars = this.avatars;
    if (avatars === undefined) return rows;
    try {
      const avatarUrls = [
        ...new Set(
          rows.flatMap((row) =>
            row.authorAvatarUrl === undefined ? [] : [row.authorAvatarUrl],
          ),
        ),
      ];
      if (avatarUrls.length === 0) return rows;
      await avatars.sync.warmAvatarUrls({ profileId, avatarUrls });
      const resolved = await resolveAvatarDataUris(
        avatars.paths,
        profileId,
        avatarUrls,
      );
      return rows.map((row) => {
        if (row.authorAvatarUrl === undefined) return row;
        const authorAvatarDataUri = resolved.get(row.authorAvatarUrl);
        return authorAvatarDataUri === undefined
          ? row
          : { ...row, authorAvatarDataUri };
      });
    } catch {
      return rows;
    }
  }

  /**
   * Reads one page of the Selected repository's inbox.
   *
   * Normalizes the request's filter once — `filter.labels` sorted and
   * deduplicated (`normalizeInboxLabels`), `awaitingMyReview` resolved — and
   * threads that one value through `decodeInboxPageToken`, `readRepository`,
   * and `composeInboxSearchQuery`. `cachedOrUnavailable` and `unavailablePage`
   * take `filter.state` alone, for the reason below.
   *
   * Only the wholly unfiltered listing — no labels, no review/check qualifier,
   * no author or base branch, and no "Awaiting review from you" preset — is
   * ever written to the cache. The cache is keyed by profile and repository
   * alone, and `cachedOrUnavailable` reads it
   * back with no label argument at all — so a label-filtered result saved
   * there would come back later as the repository's whole inbox, three
   * `label:"bug"` rows presented as everything open. Widening the key to hold
   * one entry per label combination was rejected in ADR 0031's terms: the
   * offline value of a label-filtered snapshot does not pay for that many
   * entries. Refusing to save the filtered read instead keeps
   * `cachedOrUnavailable` and `unavailablePage` label-blind honestly, because
   * the only thing they can ever find is the unfiltered listing.
   */
  async list(
    profile: WorkspaceProfileConfig,
    repository: InboxRepositoryRef,
    request: InboxPageRequest = {
      filter: { state: "open" },
      pageSize: DEFAULT_INBOX_PAGE_SIZE,
    },
  ): Promise<Result<MaintainerInbox, InboxPageRequestFailure>> {
    const filter: NormalizedInboxFilter = {
      ...request.filter,
      labels: normalizeInboxLabels(request.filter.labels),
      awaitingMyReview: request.filter.awaitingMyReview ?? false,
    };
    const pageToken = decodeInboxPageToken({
      repository,
      filter,
      pageSize: request.pageSize,
      pageToken: request.pageToken,
    });
    if (pageToken === undefined) return { _tag: "err", error: "invalid_page" };

    const authenticated =
      await this.github.resolveAuthenticatedAccount(profile);
    if (authenticated._tag === "err")
      return request.pageToken === undefined
        ? await this.cachedOrUnavailable(
            profile,
            repository,
            filter.state,
            request.pageSize,
          )
        : this.unavailablePage(repository, filter.state, request.pageSize);

    const sessions = await this.sessions.listSessions(profile.id);
    const allSessions = sessions._tag === "ok" ? sessions.value : [];
    const repositorySessions = allSessions.filter((session) =>
      sameRepositoryIdentity(session.key, repository),
    );
    const read = await this.readRepository({
      profile,
      repository,
      filter,
      pageSize: request.pageSize,
      cursor: pageToken.cursor,
      sessions: repositorySessions,
    });
    const visible = read.entries.slice(0, request.pageSize);
    const hasNextPage =
      read.entries.length > visible.length || read.hasNextPage;
    const complete = !hasNextPage && read.repository.complete;
    const dataFreshness: InboxDataFreshness =
      read.repository.state === "ready" ||
      read.repository.state === "no_open_prs"
        ? "fresh"
        : "cached";
    const refreshedAt = this.clock.now();
    const cursor =
      visible.at(-1)?.cursor ?? read.emptyPageEndCursor ?? pageToken.cursor;
    const baseNextToken = {
      state: filter.state,
      page: pageToken.page + 1,
      size: request.pageSize,
      repository: {
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
      },
      labels: filter.labels,
      awaitingMyReview: filter.awaitingMyReview,
      reviewState: filter.reviewState,
      checkStatus: filter.checkStatus,
      author: filter.author,
      baseBranch: filter.baseBranch,
    };
    const nextPageToken = hasNextPage
      ? encodeInboxPageToken(
          cursor === undefined ? baseNextToken : { ...baseNextToken, cursor },
        )
      : undefined;
    const matchCountField =
      read.issueCount === undefined ? {} : { matchCount: read.issueCount };
    // Only the returned rows carry the resolved `data:` URI; the cache below
    // is written from `visible` so the file never holds base64 image bytes.
    const rows = await this.withResolvedAuthorAvatars(
      profile.id,
      dataFreshness === "fresh"
        ? visible.map((entry) => entry.row)
        : visible.map((entry) => toCachedRow(entry.row)),
    );
    const value: MaintainerInbox = {
      state: filter.state,
      pageSize: request.pageSize,
      rows,
      repositories: [read.repository],
      refreshedAt,
      dataFreshness,
      snapshot: { state: complete ? "current" : "partial", refreshedAt },
      ...matchCountField,
    };
    if (
      filter.state === "open" &&
      filter.labels.length === 0 &&
      !filter.awaitingMyReview &&
      filter.reviewState === undefined &&
      filter.checkStatus === undefined &&
      filter.author === undefined &&
      filter.baseBranch === undefined &&
      request.pageToken === undefined &&
      complete &&
      dataFreshness === "fresh"
    ) {
      const cached: MaintainerInboxCache = {
        schemaVersion: 2,
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

  private async readRepository({
    profile,
    repository,
    filter,
    pageSize,
    cursor,
    sessions,
  }: InboxRepositoryReadInput): Promise<RepositoryRead> {
    const repo = {
      host: repository.host,
      owner: repository.owner,
      repo: repository.repo,
    };
    const searchQuery = composeInboxSearchQuery([repo], filter);
    const state = filter.state;
    const searched = await this.github.searchMaintainerPullRequests(
      cursor === undefined
        ? { profile, repo, searchQuery, state, pageSize }
        : { profile, repo, searchQuery, state, pageSize, cursor },
    );
    if (searched._tag === "err")
      return failedRepositoryRead(repo, searched.error);
    const entries = await Promise.all(
      searched.value.entries.map(
        async ({ cursor: entryCursor, pullRequest }) => {
          const latestReview = latestReviewFor(pullRequest.summary, sessions);
          const scope = await readCurrentHeadScope(
            pullRequest.summary,
            sessions,
          );
          const insights = await readInsightReadiness(
            pullRequest.summary,
            sessions,
            this.insights,
          );
          const scopeField = scope === undefined ? {} : { scope };
          const input = {
            summary: pullRequest.summary,
            checks: pullRequest.checks,
            activeAccount: profile.ghAccount,
            dataFreshness: "fresh" as const,
            ...scopeField,
            ...definedProps({ insights }),
          };
          const row =
            latestReview === undefined
              ? projectMaintainerInboxRow(input)
              : projectMaintainerInboxRow({ ...input, latestReview });
          return { cursor: entryCursor, row };
        },
      ),
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
    state: InboxStateFilter,
    pageSize: InboxPageSize,
  ): Promise<Result<MaintainerInbox, never>> {
    if (state === "merged")
      return this.unavailablePage(repository, state, pageSize);
    const cached = await this.cache.read(profile.id, repository);
    if (cached._tag === "ok") {
      const refreshedAt = parseIsoTimestamp(cached.value.refreshedAt);
      if (refreshedAt._tag === "err")
        return this.unavailablePage(repository, state, pageSize);
      const snapshotState = isInboxCacheStale(
        Date.parse(this.clock.now()) - Date.parse(refreshedAt.value),
      )
        ? "stale_cached"
        : "failed_cached";
      const rows = await this.withResolvedAuthorAvatars(
        profile.id,
        cached.value.rows.map(toCachedRow),
      );
      return ok({
        state,
        pageSize,
        rows,
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
    return this.unavailablePage(repository, state, pageSize);
  }

  private unavailablePage(
    repository: InboxRepositoryRef,
    state: InboxStateFilter,
    pageSize: InboxPageSize,
  ): Result<MaintainerInbox, never> {
    return ok({
      state,
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

/** Sorted, deduplicated label filter — the canonical form compared against
 * a decoded page token's own `labels`. Returns a mutable `string[]` (rather
 * than `ReadonlyArray<string>`) because `InboxPageToken`'s `labels` field,
 * inferred from `inboxPageTokenSchema`'s `v.array(v.string())`, is itself
 * mutable — matching it here avoids a readonly-to-mutable cast at every
 * call site that builds or compares a token. */
export function normalizeInboxLabels(
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

function decodeInboxPageToken({
  repository,
  filter,
  pageSize,
  pageToken,
}: InboxPageTokenInput): InboxPageToken | undefined {
  if (pageToken === undefined) {
    const token: InboxPageToken = {
      state: filter.state,
      page: 1,
      size: pageSize,
      repository: {
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
      },
      labels: filter.labels,
      awaitingMyReview: filter.awaitingMyReview,
    };
    if (filter.reviewState !== undefined)
      token.reviewState = filter.reviewState;
    if (filter.checkStatus !== undefined)
      token.checkStatus = filter.checkStatus;
    if (filter.author !== undefined) token.author = filter.author;
    if (filter.baseBranch !== undefined) token.baseBranch = filter.baseBranch;
    return token;
  }
  if (pageToken.length > MAX_PAGE_TOKEN_LENGTH) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(pageToken, "base64url").toString("utf8"),
    );
    const parsed = v.safeParse(inboxPageTokenSchema, decoded);
    if (!parsed.success) return undefined;
    const value = parsed.output;
    if (
      value.state !== filter.state ||
      value.size !== pageSize ||
      !sameRepositoryIdentity(value.repository, repository) ||
      !sameLabels(value.labels, filter.labels) ||
      value.awaitingMyReview !== filter.awaitingMyReview ||
      value.reviewState !== filter.reviewState ||
      value.checkStatus !== filter.checkStatus ||
      value.author !== filter.author ||
      value.baseBranch !== filter.baseBranch
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
/**
 * Which Insight kinds Patchdesk holds for this row, and whether each is bound
 * to the head the row now shows.
 *
 * Insight records are keyed by review, not by session, so any session for this
 * pull request names the records to read — unlike `readCurrentHeadScope`,
 * which needs the current head's own retained patch. Each retained result is
 * then compared against the row's head, because a result bound to an earlier
 * revision is still readable in the workbench but no longer describes what the
 * row shows.
 *
 * The Brief is read through its own parser rather than the envelope, because
 * the tag it drives promises a Brief the workbench can open: a retained value
 * that no longer parses is one the reader would refuse, and the envelope alone
 * cannot see that. Analysis and Walkthrough have no such tag yet, so the
 * envelope's revision is all their readiness needs.
 */
async function readInsightReadiness(
  summary: PullRequestSummary,
  sessions: ReadonlyArray<ReviewSession>,
  insights: InboxInsightReader | undefined,
): Promise<InboxInsightReadiness | undefined> {
  if (insights === undefined) return undefined;
  const session = sessionForRow(summary, sessions);
  if (session === undefined) return undefined;
  const reviewId = createReviewId({
    profileId: session.key.profileId,
    host: session.key.host,
    owner: session.key.owner,
    repo: session.key.repo,
    prNumber: session.key.prNumber,
  });
  // Each kind is its own stored record, so reading them independently keeps
  // one corrupt or missing record from hiding the kinds beside it.
  const profileId = session.key.profileId;
  const [brief, analysis, walkthrough] = await Promise.all([
    insights.loadTyped(profileId, reviewId, "brief", parseStoredBrief),
    insights.load(profileId, reviewId, "analysis"),
    insights.load(profileId, reviewId, "walkthrough"),
  ]);
  const readiness = definedProps({
    brief: retainedInsightState(summary, brief),
    analysis: retainedInsightState(summary, analysis),
    walkthrough: retainedInsightState(summary, walkthrough),
  });
  return Object.keys(readiness).length === 0 ? undefined : readiness;
}

/**
 * One kind's readiness, or absent when nothing readable is retained for it.
 * Takes whatever record its kind's loader returned: both `load` and
 * `loadTyped` prove the same revision envelope, and only that is read here.
 */
function retainedInsightState(
  summary: PullRequestSummary,
  record: Result<
    InsightRecord<{ readonly revision: InsightRevision }>,
    StorageFailure
  >,
): InboxInsightState | undefined {
  if (record._tag === "err") return undefined;
  const retained = record.value.retained;
  if (retained === undefined) return undefined;
  return retained.revision.headSha === summary.headSha ? "ready" : "outdated";
}

/** Any Review session Patchdesk holds for this row's pull request, at any head. */
function sessionForRow(
  summary: PullRequestSummary,
  sessions: ReadonlyArray<ReviewSession>,
): ReviewSession | undefined {
  return sessions.find(
    (candidate) =>
      candidate.key.host === summary.ref.host &&
      candidate.key.owner === summary.ref.owner &&
      candidate.key.repo === summary.ref.repo &&
      candidate.key.prNumber === summary.ref.number,
  );
}

/** The Review session Patchdesk holds for exactly this row's current head. */
function sessionAtCurrentHead(
  summary: PullRequestSummary,
  sessions: ReadonlyArray<ReviewSession>,
): ReviewSession | undefined {
  return sessions.find(
    (candidate) =>
      candidate.key.host === summary.ref.host &&
      candidate.key.owner === summary.ref.owner &&
      candidate.key.repo === summary.ref.repo &&
      candidate.key.prNumber === summary.ref.number &&
      candidate.key.headSha === summary.headSha,
  );
}

/**
 * The Scope gauge for a row Patchdesk has already reviewed at this exact head.
 * GitHub's inbox query returns totals but no per-file lines, so the only
 * per-file evidence available here is a retained session patch — and only
 * while its head still matches, because a patch for an earlier revision would
 * describe a change the row no longer shows.
 */
async function readCurrentHeadScope(
  summary: PullRequestSummary,
  sessions: ReadonlyArray<ReviewSession>,
): Promise<ChangeScope | undefined> {
  const session = sessionAtCurrentHead(summary, sessions);
  if (session === undefined) return undefined;
  const patch = await readFile(session.patchPath, "utf8").catch(
    () => undefined,
  );
  return patch === undefined ? undefined : changeScopeFromPatch(patch);
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
  return { ...row, dataFreshness: "cached" };
}
