import type {
  GitHubReader,
  GitHubReadFailure,
  RepositoryPermissionEvidence,
} from "../adapters/github/github-adapter";
import type { ForbiddenReason } from "../adapters/github/command-runner";
import type { ConfirmedWriteJournal } from "../adapters/storage/recent-write-journal-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type { PullRequestSummary } from "../domain/github-context";
import type { GitHubWriteFailure } from "../domain/github-write";
import type { RefusalCause } from "../domain/github-write-refusal";
import type {
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import type { ReviewSessionKey } from "../domain/review-session";
import type { PullRequestReviewSource } from "../domain/review-source";
import {
  confirmReviewWrite,
  markReviewWriteOutcomeUnknown,
  type ReviewWriteIntent,
  type ReviewWriteOperation,
} from "../domain/review-write-operation";
import { casesHandled, err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import {
  postDesktopNotification,
  type DesktopNotifier,
} from "./desktop-notifier";
import { settleRefusedWrite } from "./refused-write-settlement";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { ReviewWriteGateFailure } from "./review-write-gate";

/**
 * Metadata writes share admission, durable intent and failure handling; each
 * caller validates its field and performs its GitHub mutation (ADR 0029).
 * `resolvePullRequestWritePermission` shares evidence gathering; each caller
 * projects its capability as `permitted`, `denied` or `unknown`. Labels allow
 * triage permission; reviewers require pull-request write, so sharing the
 * label projection would enable a reviewer picker for a triage-only account.
 */

/**
 * GitHub refused a metadata write. As a write's own result it is only the
 * refusal; `runGuardedMetadataWrite` settles it with a pull request read and
 * returns it to the caller only when the refusal is final (nothing was
 * written and the Review is unlocked), otherwise `outcome_unknown`.
 */
export class GitHubRefusedMetadataWrite {
  readonly reason = "github_refused";
  constructor(readonly cause: RefusalCause) {}
}

/**
 * The failure vocabulary the metadata writes share. Each service's own
 * failure type is this union, optionally widened by a reason only that write
 * can produce (`assignee_cap_exceeded`).
 */
export type PullRequestMetadataWriteFailure =
  | GitHubRefusedMetadataWrite
  | "invalid_input"
  | "not_found"
  | "permission_denied"
  | "forbidden"
  | "github_read_failed"
  | "github_write_failed"
  | "outcome_unknown"
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
  key: ReviewSessionKey<PullRequestReviewSource>,
): PullRequestRef {
  return {
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    number: key.source.prNumber,
  };
}

/** Keeps a refused or rate-limited write distinguishable from a generic one. A refusal is settled by `runGuardedMetadataWrite`. */
export function mapGitHubWriteFailure(
  failure: GitHubWriteFailure,
):
  | GitHubRefusedMetadataWrite
  | "rate_limited"
  | "forbidden"
  | "github_write_failed"
  | "outcome_unknown" {
  if (failure.category === "refused")
    return new GitHubRefusedMetadataWrite(failure.cause);
  if (failure.category === "unavailable") return "outcome_unknown";
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
 * Runs one metadata write through local validation, synchronous admission,
 * deterministic preflight, durable intent, remote mutation, and confirmation.
 */
/** Deterministic metadata preflight result captured before durable admission. */
export type PreparedMetadataWrite<Receipt, Failure> = {
  readonly sessionId: ReviewSessionId;
  readonly profile: WorkspaceProfileConfig;
  readonly pullRequest: PullRequestRef;
  /** The pull request as the write's own preparation read it; the landed check compares against it. */
  readonly before: PullRequestSummary;
  readonly intent: ReviewWriteIntent;
  readonly write: () => Promise<Result<Receipt, Failure>>;
};

export async function runGuardedMetadataWrite<
  Receipt,
  Failure extends string | GitHubRefusedMetadataWrite,
>(input: {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly coordinator: ReviewOperationCoordinator;
  readonly operations: Pick<
    ReviewWriteOperationStore,
    "load" | "begin" | "markOutcomeUnknown" | "confirm" | "reject" | "remove"
  >;
  readonly recentWrites: ConfirmedWriteJournal;
  /** The one read a refused write's landed check makes. */
  readonly github: Pick<GitHubReader, "getPullRequest">;
  readonly now: () => IsoTimestamp;
  readonly validate: () => Result<void, Failure>;
  readonly prepare: () => Promise<
    Result<PreparedMetadataWrite<Receipt, Failure>, Failure>
  >;
  readonly journalEntry: (receipt: Receipt) => RecentReviewWrite;
  readonly notifier?: DesktopNotifier | undefined;
}): Promise<
  Result<Receipt, Failure | "review_write_in_progress" | "outcome_unknown">
> {
  const validated = input.validate();
  if (validated._tag === "err") return validated;
  const key = `${input.profileId}:${input.reviewId}`;
  if (!input.coordinator.acquire(key)) return err("review_write_in_progress");
  // Set once this call's own operation is outcome-unknown; only `reject` or `remove` clears it.
  let leftLocked: PullRequestRef | undefined;
  try {
    const active = await input.operations.load(input.profileId, input.reviewId);
    if (active._tag === "err" || active.value !== undefined)
      return err("outcome_unknown");
    const prepared = await input.prepare();
    if (prepared._tag === "err") return prepared;
    const operation: ReviewWriteOperation = {
      schemaVersion: 1,
      profileId: input.profileId,
      reviewId: input.reviewId,
      sessionId: prepared.value.sessionId,
      intent: prepared.value.intent,
      state: { _tag: "Requested" },
      startedAt: input.now(),
    };
    const begun = await input.operations.begin(operation);
    if (begun._tag === "err") return err("outcome_unknown");
    const unknown = markReviewWriteOutcomeUnknown(operation);
    if (unknown._tag === "err") return err("outcome_unknown");
    const marked = await input.operations.markOutcomeUnknown(unknown.value);
    if (marked._tag === "err") return err("outcome_unknown");
    leftLocked = prepared.value.pullRequest;
    let result: Result<Receipt, Failure>;
    try {
      result = await prepared.value.write();
    } catch {
      return err("outcome_unknown");
    }
    if (result._tag === "err") {
      if (result.error === "outcome_unknown") return result;
      if (result.error instanceof GitHubRefusedMetadataWrite) {
        const { cause } = result.error;
        const settled = await settleRefusedWrite({
          kind: prepared.value.intent._tag,
          cause,
          isUnchanged: async () => {
            try {
              const current = await input.github.getPullRequest({
                profile: prepared.value.profile,
                pr: prepared.value.pullRequest,
              });
              return (
                current._tag === "ok" &&
                metadataWriteUnchanged(
                  prepared.value.intent,
                  current.value,
                  prepared.value.before,
                )
              );
            } catch {
              return false;
            }
          },
          recordRejection: async () =>
            (await input.operations.reject(operation))._tag === "ok",
        });
        // A refusal that cannot be proven final keeps the lock for ADR 0035 recovery.
        if (settled._tag === "OutcomeUnknown") return err("outcome_unknown");
        leftLocked = undefined;
        return result;
      }
      const rejected = await input.operations.reject(operation);
      if (rejected._tag === "err") return err("outcome_unknown");
      leftLocked = undefined;
      return result;
    }
    const receipt = input.journalEntry(result.value);
    const confirmedOperation = confirmReviewWrite(unknown.value, receipt);
    if (confirmedOperation._tag === "err") return err("outcome_unknown");
    const confirmed = await input.operations.confirm(confirmedOperation.value);
    if (confirmed._tag === "err") return err("outcome_unknown");
    await input.recentWrites.appendConfirmed(
      input.profileId,
      input.reviewId,
      receipt,
      input.now(),
    );
    const removed = await input.operations.remove(
      input.profileId,
      input.reviewId,
    );
    if (removed._tag === "err") return err("outcome_unknown");
    leftLocked = undefined;
    return ok(result.value);
  } finally {
    input.coordinator.release(key);
    if (leftLocked !== undefined)
      postDesktopNotification(input.notifier, {
        _tag: "WriteNeedsRecovery",
        reviewId: input.reviewId,
        pullRequest: leftLocked,
      });
  }
}

/**
 * Whether a pull request read proves a refused metadata write did not land:
 * the exact field the write changes still holds the state it had before the
 * write, on the same pull request. Never inferred from the recovery
 * classifier answering "check required", which also covers an incomplete read.
 *
 * An add is unchanged only while every intended label, assignee, or reviewer
 * is still missing; a remove only while every one is still present. A read
 * without assignees or requested reviewers, or one whose label list is
 * truncated when the label would have to be missing, proves nothing.
 */
function metadataWriteUnchanged(
  intent: ReviewWriteIntent,
  current: PullRequestSummary,
  before: PullRequestSummary,
): boolean {
  switch (intent._tag) {
    case "AddLabels":
    case "RemoveLabels": {
      const names = new Set(current.labels.map((label) => label.name));
      if (intent._tag === "RemoveLabels")
        return intent.names.every((name) => names.has(name));
      const truncated =
        current.labelCount !== undefined &&
        current.labelCount > current.labels.length;
      return !truncated && intent.names.every((name) => !names.has(name));
    }
    case "AddAssignees":
    case "RemoveAssignees":
      return membershipUnchanged(
        intent.logins,
        current.assignees,
        intent._tag === "RemoveAssignees",
      );
    case "RequestReviewers":
    case "RemoveReviewers":
      return membershipUnchanged(
        intent.logins,
        current.requestedReviewers,
        intent._tag === "RemoveReviewers",
      );
    case "SetDraftState":
      return (
        current.isDraft === before.isDraft && current.isDraft !== intent.draft
      );
    case "SetBaseBranch":
      return (
        current.baseBranch === before.baseBranch &&
        current.baseBranch !== intent.branch
      );
    // Conversation and published-feedback writes have their own landed checks.
    case "CreateComment":
    case "Reply":
    case "SetThreadState":
    case "EditComment":
    case "DeleteComment":
    case "EditPublishedComment":
    case "DeletePublishedComment":
    case "DismissPublishedReview":
      return false;
    default:
      return casesHandled(intent);
  }
}

function membershipUnchanged(
  logins: ReadonlyArray<string>,
  current: ReadonlyArray<string> | undefined,
  expectPresent: boolean,
): boolean {
  if (current === undefined) return false;
  const members = new Set(current);
  return logins.every((login) => members.has(login) === expectPresent);
}
