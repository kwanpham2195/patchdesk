import { dirname, join } from "node:path";

import * as v from "valibot";

import { changeScopeSchema } from "../../domain/change-scope";
import { definedProps } from "../../domain/defined-props";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import {
  INBOX_DATA_FRESHNESS,
  INBOX_REPOSITORY_OUTCOMES,
  type InboxRepositoryOutcome,
  type InboxCategory,
  type InboxRecommendedAction,
  type InboxReviewSummary,
  type MaintainerInboxRow,
} from "../../domain/maintainer-inbox";
import type { PullRequestSummary } from "../../domain/github-context";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import { checksSchema, projectChecks } from "./check-summary-schema";
import {
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

export type InboxCacheRepository = {
  readonly identity: Omit<PullRequestRef, "number">;
  readonly state: InboxRepositoryOutcome;
  readonly complete: boolean;
};

export type MaintainerInboxCache = {
  readonly schemaVersion: 1;
  readonly refreshedAt: string;
  readonly rows: ReadonlyArray<MaintainerInboxRow>;
  readonly repository: InboxCacheRepository;
};

const actionSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("run_review"),
    label: v.literal("Run review"),
  }),
  v.strictObject({
    kind: v.literal("open_merged_review"),
    label: v.literal("View merged pull request"),
  }),
  v.strictObject({
    kind: v.literal("open_saved_review"),
    label: v.literal("Open Review"),
    reviewId: v.string(),
  }),
  v.strictObject({
    kind: v.literal("inspect_checks"),
    label: v.literal("Inspect failing checks"),
  }),
  v.strictObject({
    kind: v.literal("open_merge_readiness"),
    label: v.literal("Open merge readiness"),
    reviewId: v.string(),
  }),
]);

const rowSchema = v.strictObject({
  // Cache version 1 predates remoteState. Cache is open-only, so its omitted
  // state is reconstructed as open while merged pages remain uncached.
  remoteState: v.optional(v.literal("open")),
  identity: v.strictObject({
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    number: v.number(),
  }),
  title: v.pipe(v.string(), v.minLength(1)),
  author: v.pipe(v.string(), v.minLength(1)),
  baseBranch: v.pipe(v.string(), v.minLength(1)),
  headBranch: v.pipe(v.string(), v.minLength(1)),
  currentHeadSha: v.string(),
  isDraft: v.boolean(),
  updatedAt: v.string(),
  changeStats: v.strictObject({
    additions: v.optional(v.number()),
    deletions: v.optional(v.number()),
    changedFiles: v.optional(v.number()),
  }),
  checks: checksSchema,
  reviewState: v.picklist([
    "none",
    "review_pending",
    "approved",
    "changes_requested",
    "unknown",
  ]),
  mergeability: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  /** Written whenever the fresh row carried one; the cache is strict, so a row field it does not name invalidates the whole file. */
  scope: v.optional(changeScopeSchema),
  /** Named here for the same reason `scope` is: the cache is strict, so an unnamed row field invalidates the whole file. */
  briefReady: v.optional(v.literal(true)),
  latestReview: v.optional(
    v.strictObject({
      reviewId: v.string(),
      reviewedHeadSha: v.string(),
      updatedAt: v.string(),
      matchesCurrentHead: v.boolean(),
    }),
  ),
  labels: v.optional(
    v.array(v.strictObject({ name: v.string(), color: v.string() })),
  ),
  labelCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  categories: v.array(v.picklist(["updated_since_review", "ready_to_merge"])),
  recommendedAction: actionSchema,
  dataFreshness: v.picklist(INBOX_DATA_FRESHNESS),
});

const cacheSchema = v.strictObject({
  schemaVersion: v.literal(1),
  refreshedAt: v.string(),
  rows: v.array(rowSchema),
  repository: v.strictObject({
    identity: v.strictObject({
      host: v.string(),
      owner: v.string(),
      repo: v.string(),
    }),
    state: v.picklist(INBOX_REPOSITORY_OUTCOMES),
    complete: v.boolean(),
  }),
});

/**
 * Persists only parsed, JSON-safe inbox reads; it never stores source, paths,
 * credentials, or raw GitHub output.
 *
 * One cache entry belongs to one profile and one watched repository — a
 * single-repository read must not clobber another repository's cached rows —
 * so the file name folds the repository identity in alongside the profile
 * directory, as `inbox-v1__<host>__<owner>__<repo>.json`. `host`, `owner`,
 * and `repo` are already validated path-safe slugs (see
 * `parseGitHubOwner`/`parseGitHubRepoName` in `domain/ids.ts`), and `__` is
 * the same repository-identity separator `reviewIdSyntax`/`sessionIdSyntax`
 * already use elsewhere in this codebase.
 */
export class MaintainerInboxCacheStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async read(
    profileId: WorkspaceProfileId,
    repository: Pick<PullRequestRef, "host" | "owner" | "repo">,
  ): Promise<Result<MaintainerInboxCache, StorageFailure>> {
    const raw = await readJsonFile(this.cacheFile(profileId, repository));
    if (raw._tag === "err") return raw;
    return parseMaintainerInboxCache(raw.value);
  }

  async save(
    profileId: WorkspaceProfileId,
    repository: Pick<PullRequestRef, "host" | "owner" | "repo">,
    cache: MaintainerInboxCache,
  ): Promise<Result<void, StorageFailure>> {
    return await writeAtomicJson(this.cacheFile(profileId, repository), cache);
  }

  private cacheFile(
    profileId: WorkspaceProfileId,
    repository: Pick<PullRequestRef, "host" | "owner" | "repo">,
  ): string {
    return join(
      dirname(this.paths.inboxCacheFile(profileId)),
      `inbox-v1__${repository.host}__${repository.owner}__${repository.repo}.json`,
    );
  }
}

/** Parse durable cache values before they become row data in a maintainer-facing API. */
export function parseMaintainerInboxCache(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON cache I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): Result<MaintainerInboxCache, StorageFailure> {
  const raw = v.safeParse(cacheSchema, input);
  if (!raw.success) return invalidCache();
  const refreshedAt = parseIsoTimestamp(raw.output.refreshedAt);
  if (refreshedAt._tag === "err") return invalidCache();

  const rows: Array<MaintainerInboxRow> = [];
  for (const row of raw.output.rows) {
    const parsed = parseRow(row);
    if (parsed._tag === "err") return invalidCache();
    rows.push(parsed.value);
  }
  const identity = parseRepositoryIdentity(raw.output.repository.identity);
  if (identity._tag === "err") return invalidCache();
  return ok({
    schemaVersion: 1,
    refreshedAt: refreshedAt.value,
    rows,
    repository: {
      identity: identity.value,
      state: raw.output.repository.state,
      complete: raw.output.repository.complete,
    },
  });
}

function parseRow(
  input: v.InferOutput<typeof rowSchema>,
): Result<MaintainerInboxRow, StorageFailure> {
  const identity = parsePullRequestIdentity(input.identity);
  const currentHeadSha = parseGitSha(input.currentHeadSha);
  const updatedAt = parseIsoTimestamp(input.updatedAt);
  const latestReview =
    input.latestReview === undefined
      ? undefined
      : parseLatestReview(input.latestReview);
  const action = parseAction(input.recommendedAction);
  if (
    identity._tag === "err" ||
    currentHeadSha._tag === "err" ||
    updatedAt._tag === "err" ||
    latestReview?._tag === "err" ||
    action._tag === "err"
  )
    return invalidCache();
  const checks = projectChecks(input.checks);
  const summaryState: PullRequestSummary["reviewState"] = input.reviewState;
  const categories: ReadonlyArray<InboxCategory> = input.categories;
  const additionsField =
    input.changeStats.additions === undefined
      ? {}
      : { additions: input.changeStats.additions };
  const deletionsField =
    input.changeStats.deletions === undefined
      ? {}
      : { deletions: input.changeStats.deletions };
  const changedFilesField =
    input.changeStats.changedFiles === undefined
      ? {}
      : { changedFiles: input.changeStats.changedFiles };
  const latestReviewField =
    latestReview === undefined ? {} : { latestReview: latestReview.value };
  const scopeField = input.scope === undefined ? {} : { scope: input.scope };
  const labels = input.labels ?? [];
  const labelCountField =
    input.labelCount === undefined ? {} : { labelCount: input.labelCount };
  return ok({
    remoteState: input.remoteState ?? "open",
    identity: identity.value,
    title: input.title,
    author: input.author,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    currentHeadSha: currentHeadSha.value,
    isDraft: input.isDraft,
    updatedAt: updatedAt.value,
    changeStats: { ...additionsField, ...deletionsField, ...changedFilesField },
    checks,
    reviewState: summaryState,
    mergeability: input.mergeability,
    ...scopeField,
    ...definedProps({ briefReady: input.briefReady }),
    ...latestReviewField,
    labels,
    ...labelCountField,
    categories,
    recommendedAction: action.value,
    dataFreshness: input.dataFreshness,
  });
}

function parsePullRequestIdentity(input: {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}): Result<PullRequestRef, StorageFailure> {
  const host = parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  const number = parsePullRequestNumber(input.number);
  return host._tag === "ok" &&
    owner._tag === "ok" &&
    repo._tag === "ok" &&
    number._tag === "ok"
    ? ok({
        host: host.value,
        owner: owner.value,
        repo: repo.value,
        number: number.value,
      })
    : invalidCache();
}

function parseRepositoryIdentity(input: {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}): Result<Omit<PullRequestRef, "number">, StorageFailure> {
  const host = parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  return host._tag === "ok" && owner._tag === "ok" && repo._tag === "ok"
    ? ok({ host: host.value, owner: owner.value, repo: repo.value })
    : invalidCache();
}

function parseLatestReview(
  input: NonNullable<v.InferOutput<typeof rowSchema>["latestReview"]>,
): Result<InboxReviewSummary, StorageFailure> {
  const reviewId = parseReviewId(input.reviewId);
  const reviewedHeadSha = parseGitSha(input.reviewedHeadSha);
  const updatedAt = parseIsoTimestamp(input.updatedAt);
  return reviewId._tag === "ok" &&
    reviewedHeadSha._tag === "ok" &&
    updatedAt._tag === "ok"
    ? ok({
        reviewId: reviewId.value,
        reviewedHeadSha: reviewedHeadSha.value,
        updatedAt: updatedAt.value,
        matchesCurrentHead: input.matchesCurrentHead,
      })
    : invalidCache();
}

function parseAction(
  input: v.InferOutput<typeof actionSchema>,
): Result<InboxRecommendedAction, StorageFailure> {
  switch (input.kind) {
    case "run_review":
      return ok(input);
    case "open_merged_review":
      return ok(input);
    // Cached inboxes from before failed checks could start a review retain this old
    // shape. The cache is local, and the current policy always permits analysis.
    // Remove this branch the next time cacheSchema's schemaVersion changes for any
    // reason - that bump already invalidates old caches via invalidCache(), so this
    // migration arm stops being reachable and can be deleted in the same change.
    case "inspect_checks":
      return ok({ kind: "run_review", label: "Run review" });
    default: {
      const reviewId = parseReviewId(input.reviewId);
      return reviewId._tag === "ok"
        ? ok({ ...input, reviewId: reviewId.value })
        : invalidCache();
    }
  }
}

function invalidCache(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}
