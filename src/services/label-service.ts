import { repositoryLabelPermission } from "../adapters/github/github-adapter";
import type { GitHubReader, GitHubReviewWriter, GitHubReadFailure } from "../adapters/github/github-adapter";
import type { ForbiddenReason } from "../adapters/github/command-runner";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { GitHubWriteFailure } from "../domain/github-write";
import type { RepositoryLabel, RepositoryLabelPermission } from "../domain/github-context";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type {
  ReviewWriteGate,
  ReviewWriteGateFailure,
} from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { RecentReviewWrite } from "./review-refresh-service";

/** One label to add or remove; `name` travels alongside `id` purely so a confirmed write can journal a human-legible own-write fingerprint without a second lookup. */
export type LabelRef = {
  readonly id: string;
  readonly name: string;
};

export type LabelCommand =
  | { readonly _tag: "AddLabels"; readonly labels: ReadonlyArray<LabelRef> }
  | { readonly _tag: "RemoveLabels"; readonly labels: ReadonlyArray<LabelRef> };

export type LabelReceipt =
  | { readonly _tag: "LabelsAdded"; readonly added: ReadonlyArray<string> }
  | { readonly _tag: "LabelsRemoved"; readonly removed: ReadonlyArray<string> };

export type LabelWriteFailure =
  | "invalid_input"
  | "not_found"
  | "permission_denied"
  | "forbidden"
  | "github_read_failed"
  | "github_write_failed"
  | "rate_limited"
  | "review_write_in_progress";

/**
 * Outcome of listing a repository's available labels for one current Review.
 * Mirrors `MaintainerInboxRepository`'s read-failure vocabulary
 * (`github_auth` / `github_rate_limited` / `github_forbidden` / `github_read`)
 * so a GitHub read failure is data on the success path, not an HTTP error —
 * the same shape `GET /v1/inbox` uses for per-repo failure state.
 */
export type LabelListOutcome =
  | {
      readonly _tag: "ready";
      readonly labels: ReadonlyArray<RepositoryLabel>;
      /** GitHub's exact total; compare against `labels.length` to detect truncation. */
      readonly totalCount: number;
      /**
       * Whether this account can write labels on this repository, computed
       * the same way `execute`'s write gate computes it (`getRepositoryPermission`
       * evidence through `repositoryLabelPermission`). Carried on the read path
       * so the picker can gate its controls on real evidence instead of
       * inferring permission from a rejected write.
       */
      readonly permission: RepositoryLabelPermission;
    }
  | { readonly _tag: "github_auth" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: IsoTimestamp }
  | { readonly _tag: "github_forbidden"; readonly reason: ForbiddenReason };

/** Only the review-resolution half can fail the request outright; a GitHub read failure is conveyed as a `LabelListOutcome` instead. */
export type LabelListFailure = "not_found" | "permission_denied";

type Gateway = Pick<
  GitHubReader,
  | "getPullRequest"
  | "resolveAuthenticatedAccount"
  | "getRepositoryPermission"
  | "listRepositoryLabels"
> &
  Pick<GitHubReviewWriter, "addLabelsToLabelable" | "removeLabelsFromLabelable">;

/**
 * Owns direct, GitHub-published label reads and assignment for one current
 * Review. Labels are pull-request-level metadata, not diff-anchored, so both
 * `execute` and `list` gate on `requireCurrentSession` (proves the Review is
 * not stale/terminal) rather than `requireFresh` (which also demands exact
 * patch freshness — right for diff-anchored writes, wrong here: a new commit
 * does not invalidate a label).
 */
export class LabelService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireCurrentSession">,
    private readonly github: Gateway,
    private readonly writeCoordinator: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp,
    private readonly recentWrites: Pick<RecentWriteJournalStore, "append">,
  ) {}

  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: LabelCommand;
  }): Promise<Result<LabelReceipt, LabelWriteFailure>> {
    const localValidation = validateLocalCommand(input.command);
    if (localValidation._tag === "err") return localValidation;
    const key = `${input.profileId}:${input.reviewId}`;
    if (!this.writeCoordinator.acquire(key))
      return err("review_write_in_progress");
    try {
      const result = await this.executeUnlocked(input);
      if (result._tag === "ok") {
        // Best effort: the GitHub write already succeeded, so a durable
        // journal failure here must not fail the confirmed command.
        await this.recentWrites.append(
          input.profileId,
          input.reviewId,
          journalEntryFor(result.value),
          this.now(),
        );
      }
      return result;
    } finally {
      this.writeCoordinator.release(key);
    }
  }

  /**
   * Read-only counterpart to `execute`: the labels available to assign on
   * the current Review's repository, for populating a label picker. Reuses
   * `requireCurrentSession` purely to resolve repo identity (same reasoning
   * as `execute`'s doc comment: labels are not diff-anchored), not because a
   * read needs the write gate's guarantees.
   */
  async list(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<LabelListOutcome, LabelListFailure>> {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    // Reuses `mapGateFailure`'s exact reason mapping, but that function is
    // typed to `LabelWriteFailure` (a strictly wider union than
    // `LabelListFailure`), so the two-value read result is spelled out here
    // rather than widening the read failure type to match it.
    if (current._tag === "err")
      return err(
        current.error.reason === "not_found" ||
          current.error.reason === "storage"
          ? "not_found"
          : "permission_denied",
      );
    const pr = {
      host: current.value.session.key.host,
      owner: current.value.session.key.owner,
      repo: current.value.session.key.repo,
      number: current.value.session.key.prNumber,
    };
    const [listed, permission] = await Promise.all([
      this.github.listRepositoryLabels({
        profile: current.value.profile,
        repo: pr,
      }),
      this.resolveLabelPermission(current.value.profile, pr),
    ]);
    return ok(
      listed._tag === "ok"
        ? {
            _tag: "ready",
            labels: listed.value.labels,
            totalCount: listed.value.totalCount,
            permission,
          }
        : mapReadFailure(listed.error),
    );
  }

  /**
   * Resolves the real three-state label-write permission for one profile's
   * pull request, shared by `execute`'s write gate and `list`'s read
   * projection so the picker sees the same signal the write path enforces.
   * `getRepositoryPermission` is an optional adapter read; when it is
   * unavailable, or the resolved account does not match the configured
   * profile account, the answer is `unknown` — never `permitted`.
   */
  private async resolveLabelPermission(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<RepositoryLabelPermission> {
    const account = await this.github.resolveAuthenticatedAccount(profile);
    const permissionEvidence =
      account._tag === "ok" &&
      account.value.account === profile.ghAccount &&
      this.github.getRepositoryPermission !== undefined
        ? await this.github.getRepositoryPermission({
            profile,
            pr,
            account: account.value.account,
          })
        : undefined;
    return repositoryLabelPermission(permissionEvidence);
  }

  private async executeUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: LabelCommand;
  }): Promise<Result<LabelReceipt, LabelWriteFailure>> {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err") return err(mapGateFailure(current.error));
    const pr = {
      host: current.value.session.key.host,
      owner: current.value.session.key.owner,
      repo: current.value.session.key.repo,
      number: current.value.session.key.prNumber,
    };

    // A write attempted without `permitted` is refused here, not only in the
    // UI. `unknown` (missing/failed evidence) must never be treated as
    // permitted — only an explicit `permitted` proceeds.
    const permission = await this.resolveLabelPermission(
      current.value.profile,
      pr,
    );
    if (permission !== "permitted") return err("permission_denied");

    const pullRequest = await this.github.getPullRequest({
      profile: current.value.profile,
      pr,
    });
    if (pullRequest._tag === "err") return err("github_read_failed");
    const labelableId = pullRequest.value.nodeId;
    if (labelableId === undefined) return err("github_read_failed");

    const labelIds = input.command.labels.map((label) => label.id);
    const labelNames = input.command.labels.map((label) => label.name);

    if (input.command._tag === "AddLabels") {
      if (this.github.addLabelsToLabelable === undefined)
        return err("github_write_failed");
      const written = await this.github.addLabelsToLabelable({
        profile: current.value.profile,
        labelableId,
        labelIds,
      });
      return written._tag === "err"
        ? err(mapWriteFailure(written.error))
        : ok({ _tag: "LabelsAdded", added: labelNames });
    }
    if (this.github.removeLabelsFromLabelable === undefined)
      return err("github_write_failed");
    const written = await this.github.removeLabelsFromLabelable({
      profile: current.value.profile,
      labelableId,
      labelIds,
    });
    return written._tag === "err"
      ? err(mapWriteFailure(written.error))
      : ok({ _tag: "LabelsRemoved", removed: labelNames });
  }
}

function mapGateFailure(failure: ReviewWriteGateFailure): LabelWriteFailure {
  if (failure.reason === "not_found" || failure.reason === "storage")
    return "not_found";
  // "terminal": the Review is closed/merged. "stale"/"not_fresh": the stored
  // session no longer matches the Review's own identity, an inconsistency
  // this write must refuse rather than act on. Neither invents new
  // vocabulary; both collapse into the closed taxonomy's `permission_denied`.
  return "permission_denied";
}

function mapWriteFailure(failure: GitHubWriteFailure): LabelWriteFailure {
  if (failure.category === "rate_limited") return "rate_limited";
  if (failure.category === "forbidden") return "forbidden";
  return "github_write_failed";
}

/** Keeps a forbidden or rate-limited label read specific instead of collapsing it to a generic read failure. */
function mapReadFailure(failure: GitHubReadFailure): LabelListOutcome {
  if (failure._tag === "GitHubRateLimited") {
    const resumeAtField =
      failure.resumeAt === undefined ? {} : { resumeAt: failure.resumeAt };
    return { _tag: "github_rate_limited", ...resumeAtField };
  }
  if (failure._tag === "GitHubForbidden")
    return { _tag: "github_forbidden", reason: failure.reason };
  if (failure._tag === "GitHubAuthenticationFailed") return { _tag: "github_auth" };
  return { _tag: "github_read" };
}

function journalEntryFor(receipt: LabelReceipt): RecentReviewWrite {
  return receipt._tag === "LabelsAdded"
    ? { _tag: "LabelChange", added: receipt.added, removed: [] }
    : { _tag: "LabelChange", added: [], removed: receipt.removed };
}

function validateLocalCommand(
  command: LabelCommand,
): Result<void, LabelWriteFailure> {
  if (command.labels.length === 0) return err("invalid_input");
  if (
    command.labels.some(
      (label) => label.id.trim().length === 0 || label.name.trim().length === 0,
    )
  )
    return err("invalid_input");
  return ok(undefined);
}
