import { repositoryLabelPermission } from "../adapters/github/github-adapter";
import type { GitHubReader, GitHubReviewWriter } from "../adapters/github/github-adapter";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { GitHubWriteFailure } from "../domain/github-write";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
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

type Gateway = Pick<
  GitHubReader,
  "getPullRequest" | "resolveAuthenticatedAccount" | "getRepositoryPermission"
> &
  Pick<GitHubReviewWriter, "addLabelsToLabelable" | "removeLabelsFromLabelable">;

/**
 * Owns direct, GitHub-published label assignment for one current Review.
 * Labels are pull-request-level metadata, not diff-anchored, so this gates
 * on `requireCurrentSession` (proves the Review is not stale/terminal) rather
 * than `requireFresh` (which also demands exact patch freshness — right for
 * diff-anchored writes, wrong here: a new commit does not invalidate a
 * label).
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
    const account = await this.github.resolveAuthenticatedAccount(
      current.value.profile,
    );
    const permissionEvidence =
      account._tag === "ok" &&
      account.value.account === current.value.profile.ghAccount &&
      this.github.getRepositoryPermission !== undefined
        ? await this.github.getRepositoryPermission({
            profile: current.value.profile,
            pr,
            account: account.value.account,
          })
        : undefined;
    if (repositoryLabelPermission(permissionEvidence) !== "permitted")
      return err("permission_denied");

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
