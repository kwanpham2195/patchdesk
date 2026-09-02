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
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { changeScopeFromPatch, type ChangeScope } from "../domain/change-scope";
import { definedProps } from "../domain/defined-props";
import { parseStoredBrief } from "../domain/stored-brief";
import type { PullRequestSummary } from "../domain/github-context";
import {
  createReviewId,
  parseIsoTimestamp,
  type IsoTimestamp,
} from "../domain/ids";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_CHECK_STATUS_FILTER_VALUES,
  INBOX_PAGE_SIZES,
  INBOX_REVIEW_STATE_FILTER_VALUES,
  type InboxPageRequest,
  type InboxPageSize,
  INBOX_STATE_FILTER_VALUES,
  type InboxCheckStatusFilter,
  type InboxReviewStateFilter,
  type InboxStateFilter,
  projectMaintainerInboxRow,
  type InboxReviewSummary,
  type MaintainerInboxRow,
  type InboxDataFreshness,
  type InboxSnapshotState,
} from "../domain/maintainer-inbox";
import type { PullRequestRef } from "../domain/pull-request";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import type { ReviewSession } from "../domain/review-session";
import { ok, type Result } from "../domain/result";
import type {
  WorkspaceProfileConfig,
  WatchedRepoConfig,
} from "../domain/workspace-profile";
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
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_REPOSITORY_CURSOR_LENGTH),
    ),
  ),
});

type InboxPageToken = v.InferOutput<typeof inboxPageTokenSchema>;

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
/** The one Insight read the inbox makes: is there a Brief retained for this row? */
type BriefInsightReader = Pick<InsightStore, "loadTyped">;
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
    /**
     * Optional, like the coordinator's `remotes`: without it a row simply
     * carries no `briefReady`, and every existing caller keeps its four
     * collaborators.
     */
    private readonly insights?: BriefInsightReader,
  ) {}

  /**
   * Reads one page of the Selected repository's inbox.
   *
   * Extracts `filter.state` once into a plain `InboxStateFilter` and normalizes
   * `filter.labels` once into a sorted, deduplicated label list
   * (`normalizeInboxLabels`), then threads both through `readRepository`,
   * `cachedOrUnavailable`, `unavailablePage`, and `buildInboxSearchQuery`.
   *
   * Only the wholly unfiltered listing — no labels, no review/check qualifier,
   * and no "Awaiting review from you" preset — is ever written to the cache. The cache is
   * keyed by profile and repository alone, and `cachedOrUnavailable` reads it
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
    const state = request.filter.state;
    const labels = normalizeInboxLabels(request.filter.labels);
    const awaitingMyReview = request.filter.awaitingMyReview ?? false;
    const reviewState = request.filter.reviewState;
    const checkStatus = request.filter.checkStatus;
    const pageToken = decodeInboxPageToken(
      request,
      repository,
      state,
      labels,
      awaitingMyReview,
      reviewState,
      checkStatus,
    );
    if (pageToken === undefined) return { _tag: "err", error: "invalid_page" };

    const authenticated =
      await this.github.resolveAuthenticatedAccount(profile);
    if (authenticated._tag === "err")
      return request.pageToken === undefined
        ? await this.cachedOrUnavailable(
            profile,
            repository,
            state,
            request.pageSize,
          )
        : this.unavailablePage(repository, state, request.pageSize);

    const sessions = await this.sessions.listSessions(profile.id);
    const allSessions = sessions._tag === "ok" ? sessions.value : [];
    const repositorySessions = allSessions.filter((session) =>
      sameRepositoryIdentity(session.key, repository),
    );
    const read = await this.readRepository(
      profile,
      repository,
      state,
      labels,
      awaitingMyReview,
      reviewState,
      checkStatus,
      request.pageSize,
      pageToken.cursor,
      repositorySessions,
    );
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
      state,
      page: pageToken.page + 1,
      size: request.pageSize,
      repository: {
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
      },
      labels,
      awaitingMyReview,
      reviewState,
      checkStatus,
    };
    const nextPageToken = hasNextPage
      ? encodeInboxPageToken(
          cursor === undefined ? baseNextToken : { ...baseNextToken, cursor },
        )
      : undefined;
    const matchCountField =
      read.issueCount === undefined ? {} : { matchCount: read.issueCount };
    const value: MaintainerInbox = {
      state,
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
      state === "open" &&
      labels.length === 0 &&
      !awaitingMyReview &&
      reviewState === undefined &&
      checkStatus === undefined &&
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
    state: InboxStateFilter,
    labels: ReadonlyArray<string>,
    awaitingMyReview: boolean,
    reviewState: InboxReviewStateFilter | undefined,
    checkStatus: InboxCheckStatusFilter | undefined,
    pageSize: InboxPageSize,
    cursor: string | undefined,
    sessions: ReadonlyArray<ReviewSession>,
  ): Promise<RepositoryRead> {
    const repo = {
      host: repository.host,
      owner: repository.owner,
      repo: repository.repo,
    };
    const searchQuery = buildInboxSearchQuery(
      repo,
      state,
      labels,
      awaitingMyReview,
      reviewState,
      checkStatus,
    );
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
          const briefReady = await readCurrentHeadBrief(
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
            ...definedProps({ briefReady }),
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
      return ok({
        state,
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

/**
 * Builds the GitHub search qualifier string for one repository, state, label
 * filter, review/check qualifiers, and preset: `repo:OWNER/NAME is:pr is:open
 * user-review-requested:@me review:approved status:failure label:"NAME"`. The sole place
 * that builds this string, so every renderer-chosen filter extends it here
 * rather than through ad hoc concatenation elsewhere — and so GitHub's
 * 256-character search cap has one place to be enforced. `labels` is trusted
 * here: the route already bounds its count, length, and character set
 * (see `parseInboxLabelsQuery` in `local-api.ts`) before it reaches this
 * function, so a label name can never contain the quote it is wrapped in.
 */
function buildInboxSearchQuery(
  repo: InboxRepositoryRef,
  state: InboxStateFilter,
  labels: ReadonlyArray<string>,
  awaitingMyReview: boolean,
  reviewState: InboxReviewStateFilter | undefined,
  checkStatus: InboxCheckStatusFilter | undefined,
): string {
  const stateQualifier = state === "merged" ? "is:merged" : "is:open";
  // `@me` is GitHub's own token for the authenticated viewer and is resolved
  // server-side, so this needs no viewer login lookup. Probed 2026-08-26:
  // `author:@me` and `author:<login>` return the identical `issueCount`.
  const qualifiers = [
    ...(awaitingMyReview ? ["user-review-requested:@me"] : []),
    ...(reviewState === undefined ? [] : [`review:${reviewState}`]),
    ...(checkStatus === undefined ? [] : [`status:${checkStatus}`]),
    ...labels.map((label) => `label:"${label}"`),
  ].join(" ");
  const base = `repo:${repo.owner}/${repo.repo} is:pr ${stateQualifier}`;
  return qualifiers.length === 0 ? base : `${base} ${qualifiers}`;
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

function decodeInboxPageToken(
  request: InboxPageRequest,
  repository: InboxRepositoryRef,
  state: InboxStateFilter,
  labels: string[],
  awaitingMyReview: boolean,
  reviewState: InboxReviewStateFilter | undefined,
  checkStatus: InboxCheckStatusFilter | undefined,
): InboxPageToken | undefined {
  if (request.pageToken === undefined) {
    const token: InboxPageToken = {
      state,
      page: 1,
      size: request.pageSize,
      repository: {
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
      },
      labels,
      awaitingMyReview,
    };
    if (reviewState !== undefined) token.reviewState = reviewState;
    if (checkStatus !== undefined) token.checkStatus = checkStatus;
    return token;
  }
  if (request.pageToken.length > MAX_PAGE_TOKEN_LENGTH) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(request.pageToken, "base64url").toString("utf8"),
    );
    const parsed = v.safeParse(inboxPageTokenSchema, decoded);
    if (!parsed.success) return undefined;
    const value = parsed.output;
    if (
      value.state !== state ||
      value.size !== request.pageSize ||
      !sameRepositoryIdentity(value.repository, repository) ||
      !sameLabels(value.labels, labels) ||
      value.awaitingMyReview !== awaitingMyReview ||
      value.reviewState !== reviewState ||
      value.checkStatus !== checkStatus
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
 * Whether Patchdesk holds a Brief to read for this row's current head.
 *
 * The session lookup is `readCurrentHeadScope`'s: a session at this exact head
 * is what names the review whose Insight records to read. The retained Brief is
 * then checked against the row's head as well, because a Brief bound to an
 * earlier revision is readable in the workbench but is not a Brief of what the
 * row now shows.
 */
async function readCurrentHeadBrief(
  summary: PullRequestSummary,
  sessions: ReadonlyArray<ReviewSession>,
  insights: BriefInsightReader | undefined,
): Promise<true | undefined> {
  if (insights === undefined) return undefined;
  const session = sessionAtCurrentHead(summary, sessions);
  if (session === undefined) return undefined;
  const record = await insights.loadTyped(
    session.key.profileId,
    createReviewId({
      profileId: session.key.profileId,
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      prNumber: session.key.prNumber,
    }),
    "brief",
    parseStoredBrief,
  );
  if (record._tag === "err") return undefined;
  const retained = record.value.retained;
  return retained !== undefined && retained.revision.headSha === summary.headSha
    ? true
    : undefined;
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
