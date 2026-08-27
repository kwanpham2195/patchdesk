import type {
  GitHubReader,
  GitHubReadFailure,
  RepositoryPermissionEvidence,
} from "../adapters/github/github-adapter";
import type { ForbiddenReason } from "../adapters/github/command-runner";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { GitHubWriteFailure } from "../domain/github-write";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import type { ReviewSessionKey } from "../domain/review-session";
import { err, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { ReviewWriteGateFailure } from "./review-write-gate";

/**
 * What every pull request metadata write — labels, assignees, review
 * requests — shares, per ADR "The conversation rail owns pull request
 * metadata writes": the same guard around the write, the same translation
 * of a GitHub failure, and the same three-state permission resolution.
 *
 * What is deliberately *not* here is each write's own field validation and
 * its own GitHub call. Those are the parts that genuinely differ, and they
 * stay in `label-service.ts`, `assignee-service.ts` and
 * `reviewer-service.ts`.
 *
 * Permission in particular stays resolved per write type. That ADR rejects
 * collapsing label permission into pull-request-write permission — it would
 * show an enabled reviewer picker to a triage-only account — so
 * `resolvePullRequestWritePermission` shares only the *evidence gathering*
 * and takes the projection as an argument, leaving each caller to name the
 * capability it actually needs.
 */

/**
 * The failure vocabulary the three metadata writes share. Each service's own
 * failure type is this union, optionally widened by a reason only that write
 * can produce (`assignee_cap_exceeded`).
 */
export type PullRequestMetadataWriteFailure =
  | "invalid_input"
  | "not_found"
  | "permission_denied"
  | "forbidden"
  | "github_read_failed"
  | "github_write_failed"
  | "rate_limited"
  | "review_write_in_progress";

/**
 * A GitHub read failure carried as data on a metadata list's success path
 * rather than as an HTTP error, so a picker can report *why* it is empty.
 * Mirrors `MaintainerInboxRepository`'s read-failure vocabulary, the same
 * shape `GET /v1/inbox` uses for per-repo failure state.
 */
export type PullRequestMetadataReadFailure =
  | { readonly _tag: "github_auth" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: IsoTimestamp }
  | { readonly _tag: "github_forbidden"; readonly reason: ForbiddenReason };

/** Only the review-resolution half can fail a metadata list outright. */
export type PullRequestMetadataListFailure = "not_found" | "permission_denied";

/** The pull request a current Review's session names. */
export function pullRequestRefForSession(
  key: ReviewSessionKey,
): PullRequestRef {
  return {
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    number: key.prNumber,
  };
}

/** Keeps a refused or rate-limited write distinguishable from a generic one. */
export function mapGitHubWriteFailure(
  failure: GitHubWriteFailure,
): "rate_limited" | "forbidden" | "github_write_failed" {
  if (failure.category === "rate_limited") return "rate_limited";
  if (failure.category === "forbidden") return "forbidden";
  return "github_write_failed";
}

/** Keeps a forbidden or rate-limited metadata read specific instead of collapsing it to a generic read failure. */
export function mapGitHubReadFailure(
  failure: GitHubReadFailure,
): PullRequestMetadataReadFailure {
  if (failure._tag === "GitHubRateLimited") {
    const resumeAtField =
      failure.resumeAt === undefined ? {} : { resumeAt: failure.resumeAt };
    return { _tag: "github_rate_limited", ...resumeAtField };
  }
  if (failure._tag === "GitHubForbidden")
    return { _tag: "github_forbidden", reason: failure.reason };
  if (failure._tag === "GitHubAuthenticationFailed")
    return { _tag: "github_auth" };
  return { _tag: "github_read" };
}

/**
 * Collapses a write-gate refusal into the closed metadata taxonomy.
 *
 * "terminal": the Review is closed/merged. "stale"/"not_fresh": the stored
 * session no longer matches the Review's own identity, an inconsistency a
 * write must refuse rather than act on. Neither invents new vocabulary.
 *
 * The two values returned are exactly a metadata *list*'s whole failure
 * type, and a subset of every metadata *write*'s, so both paths call this
 * one function instead of a write-typed version plus a hand-inlined read
 * copy of the same two branches.
 */
export function mapMetadataGateFailure(
  failure: ReviewWriteGateFailure,
): PullRequestMetadataListFailure {
  if (failure.reason === "not_found" || failure.reason === "storage")
    return "not_found";
  return "permission_denied";
}

/**
 * Gathers this account's repository-permission evidence for one pull
 * request and hands it to the caller's projection.
 *
 * `getRepositoryPermission` is an optional adapter read; when it is
 * unavailable, or the resolved account does not match the configured
 * profile account, no evidence is gathered and the projection sees
 * `undefined` — which every projection turns into `unknown`, never
 * `permitted`. `project` is the per-write-type half: `repositoryLabelPermission`
 * for labels, `pullRequestWritePermission` for assignees and reviewers.
 */
export async function resolvePullRequestWritePermission<Permission>(input: {
  readonly github: Pick<
    GitHubReader,
    "resolveAuthenticatedAccount" | "getRepositoryPermission"
  >;
  readonly profile: WorkspaceProfileConfig;
  readonly pr: PullRequestRef;
  readonly project: (
    evidence:
      | Result<RepositoryPermissionEvidence, GitHubReadFailure>
      | undefined,
  ) => Permission;
}): Promise<Permission> {
  const account = await input.github.resolveAuthenticatedAccount(input.profile);
  const evidence =
    account._tag === "ok" &&
    account.value.account === input.profile.ghAccount &&
    input.github.getRepositoryPermission !== undefined
      ? await input.github.getRepositoryPermission({
          profile: input.profile,
          pr: input.pr,
          account: account.value.account,
        })
      : undefined;
  return input.project(evidence);
}

/**
 * Runs one pull request metadata write under the guards every such write
 * takes: local validation first, then a per-Review exclusive lock, then the
 * write itself, then a best-effort journal entry.
 *
 * Validation runs *before* the lock so a request that cannot succeed never
 * blocks a concurrent one. The journal append is best effort: the GitHub
 * write has already succeeded by then, so a durable journal failure must not
 * fail a confirmed command. The lock is released in a `finally` so a thrown
 * write cannot strand the Review.
 */
export async function runGuardedMetadataWrite<
  Receipt,
  Failure extends string,
>(input: {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly coordinator: ReviewOperationCoordinator;
  readonly recentWrites: Pick<RecentWriteJournalStore, "append">;
  readonly now: () => IsoTimestamp;
  readonly validate: () => Result<void, Failure>;
  readonly write: () => Promise<Result<Receipt, Failure>>;
  readonly journalEntry: (receipt: Receipt) => RecentReviewWrite;
}): Promise<Result<Receipt, Failure | "review_write_in_progress">> {
  const validated = input.validate();
  if (validated._tag === "err") return validated;
  const key = `${input.profileId}:${input.reviewId}`;
  if (!input.coordinator.acquire(key)) return err("review_write_in_progress");
  try {
    const result = await input.write();
    if (result._tag === "ok")
      await input.recentWrites.append(
        input.profileId,
        input.reviewId,
        input.journalEntry(result.value),
        input.now(),
      );
    return result;
  } finally {
    input.coordinator.release(key);
  }
}
