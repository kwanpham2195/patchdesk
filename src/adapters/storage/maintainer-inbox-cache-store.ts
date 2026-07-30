import * as v from "valibot";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewSessionId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import type {
  InboxCategory,
  InboxRecommendedAction,
  InboxReviewSummary,
  MaintainerInboxRow,
} from "../../domain/maintainer-inbox";
import type { CheckSummary, PullRequestSummary } from "../../domain/github-context";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import {
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

export type InboxCacheRepository = {
  readonly identity: Omit<PullRequestRef, "number">;
  readonly state: "ready" | "missing_local_path" | "github_auth" | "github_read" | "archived" | "no_open_prs";
  readonly complete: boolean;
};

export type MaintainerInboxCache = {
  readonly schemaVersion: 1;
  readonly refreshedAt: string;
  readonly rows: ReadonlyArray<MaintainerInboxRow>;
  readonly repositories: ReadonlyArray<InboxCacheRepository>;
};

const checkSchema = v.strictObject({
  overall: v.picklist(["passing", "failing", "pending", "skipped", "unknown"]),
  checks: v.array(v.strictObject({
    name: v.pipe(v.string(), v.minLength(1)),
    required: v.union([v.boolean(), v.literal("unknown")]),
    status: v.picklist(["queued", "in_progress", "completed", "unknown"]),
    conclusion: v.optional(v.picklist(["success", "failure", "cancelled", "timed_out", "skipped", "neutral"])),
    url: v.optional(v.pipe(v.string(), v.url())),
  })),
});

const actionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("run_review"), label: v.literal("Run review") }),
  v.strictObject({ kind: v.literal("review_updates"), label: v.literal("Review updates"), baseSessionId: v.string() }),
  v.strictObject({ kind: v.literal("continue_review"), label: v.literal("View review progress"), sessionId: v.string() }),
  v.strictObject({ kind: v.literal("open_saved_review"), label: v.literal("Open saved review"), sessionId: v.string() }),
  v.strictObject({ kind: v.literal("inspect_checks"), label: v.literal("Inspect failing checks") }),
  v.strictObject({ kind: v.literal("open_merge_readiness"), label: v.literal("Open merge readiness"), sessionId: v.string() }),
  v.strictObject({ kind: v.literal("open_discussion"), label: v.literal("Review author response"), sessionId: v.string() }),
]);

const rowSchema = v.strictObject({
  identity: v.strictObject({ host: v.string(), owner: v.string(), repo: v.string(), number: v.number() }),
  title: v.pipe(v.string(), v.minLength(1)),
  author: v.pipe(v.string(), v.minLength(1)),
  baseBranch: v.pipe(v.string(), v.minLength(1)),
  headBranch: v.pipe(v.string(), v.minLength(1)),
  currentHeadSha: v.string(),
  isDraft: v.boolean(),
  updatedAt: v.string(),
  changeStats: v.strictObject({ additions: v.optional(v.number()), deletions: v.optional(v.number()), changedFiles: v.optional(v.number()) }),
  checks: checkSchema,
  reviewState: v.picklist(["none", "review_pending", "approved", "changes_requested", "unknown"]),
  mergeability: v.picklist(["mergeable", "conflicting", "blocked", "unknown"]),
  latestReview: v.optional(v.strictObject({
    sessionId: v.string(),
    reviewedHeadSha: v.string(),
    state: v.picklist(["starting", "running", "completed", "failed", "draft", "submitted", "merged"]),
    updatedAt: v.string(),
    matchesCurrentHead: v.boolean(),
  })),
  categories: v.array(v.picklist(["needs_review", "updated_since_review", "waiting_for_author", "checks_failing", "checks_pending", "ready_to_merge", "draft", "authored", "running", "saved_review"])),
  recommendedAction: actionSchema,
  dataFreshness: v.picklist(["fresh", "cached"]),
});

const cacheSchema = v.strictObject({
  schemaVersion: v.literal(1),
  refreshedAt: v.string(),
  rows: v.array(rowSchema),
  repositories: v.array(v.strictObject({
    identity: v.strictObject({ host: v.string(), owner: v.string(), repo: v.string() }),
    state: v.picklist(["ready", "missing_local_path", "github_auth", "github_read", "archived", "no_open_prs"]),
    complete: v.boolean(),
  })),
});

/** Persists only parsed, JSON-safe inbox reads; it never stores source, paths, credentials, or raw GitHub output. */
export class MaintainerInboxCacheStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async read(profileId: WorkspaceProfileId): Promise<Result<MaintainerInboxCache, StorageFailure>> {
    const raw = await readJsonFile(this.paths.inboxCacheFile(profileId));
    if (raw._tag === "err") return raw;
    return parseMaintainerInboxCache(raw.value);
  }

  async save(profileId: WorkspaceProfileId, cache: MaintainerInboxCache): Promise<Result<void, StorageFailure>> {
    return await writeAtomicJson(this.paths.inboxCacheFile(profileId), cache);
  }
}

/** Parse durable cache values before they become row data in a maintainer-facing API. */
export function parseMaintainerInboxCache(input: unknown): Result<MaintainerInboxCache, StorageFailure> {
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
  const repositories: Array<InboxCacheRepository> = [];
  for (const repository of raw.output.repositories) {
    const identity = parseRepositoryIdentity(repository.identity);
    if (identity._tag === "err") return invalidCache();
    repositories.push({ identity: identity.value, state: repository.state, complete: repository.complete });
  }
  return ok({ schemaVersion: 1, refreshedAt: refreshedAt.value, rows, repositories });
}

function parseRow(input: v.InferOutput<typeof rowSchema>): Result<MaintainerInboxRow, StorageFailure> {
  const identity = parsePullRequestIdentity(input.identity);
  const currentHeadSha = parseGitSha(input.currentHeadSha);
  const updatedAt = parseIsoTimestamp(input.updatedAt);
  const latestReview = input.latestReview === undefined ? undefined : parseLatestReview(input.latestReview);
  const action = parseAction(input.recommendedAction);
  if (identity._tag === "err" || currentHeadSha._tag === "err" || updatedAt._tag === "err" || latestReview?._tag === "err" || action._tag === "err") return invalidCache();
  const checks = projectChecks(input.checks);
  const summaryState: PullRequestSummary["reviewState"] = input.reviewState;
  const categories: ReadonlyArray<InboxCategory> = input.categories;
  return ok({
    identity: identity.value,
    title: input.title,
    author: input.author,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    currentHeadSha: currentHeadSha.value,
    isDraft: input.isDraft,
    updatedAt: updatedAt.value,
    changeStats: {
      ...(input.changeStats.additions === undefined ? {} : { additions: input.changeStats.additions }),
      ...(input.changeStats.deletions === undefined ? {} : { deletions: input.changeStats.deletions }),
      ...(input.changeStats.changedFiles === undefined ? {} : { changedFiles: input.changeStats.changedFiles }),
    },
    checks,
    reviewState: summaryState,
    mergeability: input.mergeability,
    ...(latestReview === undefined ? {} : { latestReview: latestReview.value }),
    categories,
    recommendedAction: action.value,
    dataFreshness: input.dataFreshness,
  });
}

function projectChecks(input: v.InferOutput<typeof checkSchema>): CheckSummary {
  return {
    overall: input.overall,
    checks: input.checks.map((check) => ({
      name: check.name,
      required: check.required,
      status: check.status,
      ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }),
      ...(check.url === undefined ? {} : { url: check.url }),
    })),
  };
}

function parsePullRequestIdentity(input: { readonly host: string; readonly owner: string; readonly repo: string; readonly number: number }): Result<PullRequestRef, StorageFailure> {
  const host = parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  const number = parsePullRequestNumber(input.number);
  return host._tag === "ok" && owner._tag === "ok" && repo._tag === "ok" && number._tag === "ok"
    ? ok({ host: host.value, owner: owner.value, repo: repo.value, number: number.value })
    : invalidCache();
}

function parseRepositoryIdentity(input: { readonly host: string; readonly owner: string; readonly repo: string }): Result<Omit<PullRequestRef, "number">, StorageFailure> {
  const host = parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  return host._tag === "ok" && owner._tag === "ok" && repo._tag === "ok"
    ? ok({ host: host.value, owner: owner.value, repo: repo.value })
    : invalidCache();
}

function parseLatestReview(input: NonNullable<v.InferOutput<typeof rowSchema>["latestReview"]>): Result<InboxReviewSummary, StorageFailure> {
  const sessionId = parseReviewSessionId(input.sessionId);
  const reviewedHeadSha = parseGitSha(input.reviewedHeadSha);
  const updatedAt = parseIsoTimestamp(input.updatedAt);
  return sessionId._tag === "ok" && reviewedHeadSha._tag === "ok" && updatedAt._tag === "ok"
    ? ok({ sessionId: sessionId.value, reviewedHeadSha: reviewedHeadSha.value, state: input.state, updatedAt: updatedAt.value, matchesCurrentHead: input.matchesCurrentHead })
    : invalidCache();
}

function parseAction(input: v.InferOutput<typeof actionSchema>): Result<InboxRecommendedAction, StorageFailure> {
  switch (input.kind) {
    case "run_review":
      return ok(input);
    // Cached inboxes from before failed checks could start a review retain this old
    // shape. The cache is local, and the current policy always permits analysis.
    case "inspect_checks":
      return ok({ kind: "run_review", label: "Run review" });
    case "review_updates": {
      const baseSessionId = parseReviewSessionId(input.baseSessionId);
      return baseSessionId._tag === "ok" ? ok({ ...input, baseSessionId: baseSessionId.value }) : invalidCache();
    }
    default: {
      const sessionId = parseReviewSessionId(input.sessionId);
      return sessionId._tag === "ok" ? ok({ ...input, sessionId: sessionId.value }) : invalidCache();
    }
  }
}

function invalidCache(): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason: "invalid_stored_value" });
}
