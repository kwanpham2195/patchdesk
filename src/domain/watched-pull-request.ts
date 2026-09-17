import * as v from "valibot";

import type { CheckSummary, PullRequestSummary } from "./github-context";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  type GitSha,
  type IsoTimestamp,
} from "./ids";
import type { PullRequestRef } from "./pull-request";
import { casesHandled, err, ok, type Result } from "./result";

/** How many pull requests one workspace profile may watch, so a poll stays one aliased GraphQL call. */
export const WATCHED_PULL_REQUEST_LIMIT = 20;

/** The GitHub state a watched pull request is compared against on each poll. */
export type WatchedSnapshot = {
  readonly updatedAt: IsoTimestamp;
  readonly headSha: GitSha;
  readonly reviewState: PullRequestSummary["reviewState"];
  readonly checks: CheckSummary["overall"];
  readonly state: "open" | "merged" | "closed";
};

/** One pull request the maintainer asked Patchdesk to watch (ADR 0045). */
export type WatchedPullRequest = {
  readonly ref: PullRequestRef;
  readonly snapshot: WatchedSnapshot;
  readonly watchedAt: IsoTimestamp;
};

/** The refusal of a watch past the per-profile cap; the renderer owns the sentence. */
export type WatchLimitReached = {
  readonly _tag: "WatchLimitReached";
  readonly limit: typeof WATCHED_PULL_REQUEST_LIMIT;
};

/** One change between two snapshots of a watched pull request; each posts one notification. */
export type WatchedPullRequestChange =
  | "commented"
  | "decision"
  | "checks"
  | "pushed"
  | "merged"
  | "closed";

function sameWatchedPullRequest(
  left: PullRequestRef,
  right: PullRequestRef,
): boolean {
  return (
    left.host === right.host &&
    left.owner === right.owner &&
    left.repo === right.repo &&
    left.number === right.number
  );
}

/**
 * Whether `ref` fits the watched list: an already watched pull request always
 * fits, and a new one fits below the cap.
 */
export function checkWatchCapacity(
  list: ReadonlyArray<WatchedPullRequest>,
  ref: PullRequestRef,
): Result<void, WatchLimitReached> {
  if (list.some((watched) => sameWatchedPullRequest(watched.ref, ref)))
    return ok(undefined);
  return list.length >= WATCHED_PULL_REQUEST_LIMIT
    ? err({ _tag: "WatchLimitReached", limit: WATCHED_PULL_REQUEST_LIMIT })
    : ok(undefined);
}

/**
 * Adds `entry` to the watched list. Watching a pull request already on the
 * list keeps the list as it is; a new entry past the cap is refused.
 */
export function watchPullRequest(
  list: ReadonlyArray<WatchedPullRequest>,
  entry: WatchedPullRequest,
): Result<ReadonlyArray<WatchedPullRequest>, WatchLimitReached> {
  const capacity = checkWatchCapacity(list, entry.ref);
  if (capacity._tag === "err") return capacity;
  return list.some((watched) => sameWatchedPullRequest(watched.ref, entry.ref))
    ? ok(list)
    : ok([...list, entry]);
}

/** Removes the pull request `ref` names; an unwatched ref leaves the list unchanged. */
export function unwatchPullRequest(
  list: ReadonlyArray<WatchedPullRequest>,
  ref: PullRequestRef,
): ReadonlyArray<WatchedPullRequest> {
  return list.filter((watched) => !sameWatchedPullRequest(watched.ref, ref));
}

const snapshotFields = [
  "state",
  "headSha",
  "reviewState",
  "checks",
  "updatedAt",
] as const satisfies ReadonlyArray<keyof WatchedSnapshot>;

/**
 * The changes between two snapshots, one notification each. A pull request
 * that merged or closed reports only that; a push reports no checks change,
 * because the rollup belongs to the new head; any other activity that moved
 * `updatedAt` reads as a comment or review.
 */
export function diffWatchedSnapshot(
  before: WatchedSnapshot,
  after: WatchedSnapshot,
): ReadonlyArray<WatchedPullRequestChange> {
  const changes: WatchedPullRequestChange[] = [];
  for (const field of snapshotFields) {
    if (before[field] === after[field]) continue;
    switch (field) {
      case "state":
        if (after.state !== "open") return [after.state];
        break;
      case "headSha":
        changes.push("pushed");
        break;
      case "reviewState":
        changes.push("decision");
        break;
      case "checks":
        if (!changes.includes("pushed")) changes.push("checks");
        break;
      case "updatedAt":
        if (changes.length === 0) changes.push("commented");
        break;
      default:
        return casesHandled(field);
    }
  }
  return changes;
}

const watchedPullRequestSchema = v.strictObject({
  ref: v.strictObject({
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    number: v.number(),
  }),
  snapshot: v.strictObject({
    updatedAt: v.string(),
    headSha: v.string(),
    reviewState: v.picklist([
      "none",
      "review_pending",
      "approved",
      "changes_requested",
      "unknown",
    ]),
    checks: v.picklist(["passing", "failing", "pending", "skipped", "unknown"]),
    state: v.picklist(["open", "merged", "closed"]),
  }),
  watchedAt: v.string(),
});

/** The stored watched list failed to parse; storage maps this to `invalid_stored_value`. */
type InvalidWatchedPullRequests = {
  readonly _tag: "InvalidWatchedPullRequests";
};

/** Parses a stored watched list, refusing the whole file when any entry is invalid. */
export function parseWatchedPullRequests(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the watched-pull-request JSON boundary parser.
  input: unknown,
): Result<ReadonlyArray<WatchedPullRequest>, InvalidWatchedPullRequests> {
  const raw = v.safeParse(
    v.pipe(
      v.array(watchedPullRequestSchema),
      v.maxLength(WATCHED_PULL_REQUEST_LIMIT),
    ),
    input,
  );
  const invalid = err({ _tag: "InvalidWatchedPullRequests" as const });
  if (!raw.success) return invalid;
  const parsed: WatchedPullRequest[] = [];
  for (const entry of raw.output) {
    const host = parseGitHubHost(entry.ref.host);
    const owner = parseGitHubOwner(entry.ref.owner);
    const repo = parseGitHubRepoName(entry.ref.repo);
    const number = parsePullRequestNumber(entry.ref.number);
    const updatedAt = parseIsoTimestamp(entry.snapshot.updatedAt);
    const headSha = parseGitSha(entry.snapshot.headSha);
    const watchedAt = parseIsoTimestamp(entry.watchedAt);
    if (
      host._tag === "err" ||
      owner._tag === "err" ||
      repo._tag === "err" ||
      number._tag === "err" ||
      updatedAt._tag === "err" ||
      headSha._tag === "err" ||
      watchedAt._tag === "err"
    )
      return invalid;
    parsed.push({
      ref: {
        host: host.value,
        owner: owner.value,
        repo: repo.value,
        number: number.value,
      },
      snapshot: {
        ...entry.snapshot,
        updatedAt: updatedAt.value,
        headSha: headSha.value,
      },
      watchedAt: watchedAt.value,
    });
  }
  return ok(parsed);
}
