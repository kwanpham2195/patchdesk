import { repositoryLabelPermission } from "../adapters/github/github-adapter";
import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type {
  RepositoryLabel,
  RepositoryLabelPermission,
} from "../domain/github-context";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewWriteGate } from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import {
  mapGitHubReadFailure,
  mapGitHubWriteFailure,
  mapMetadataGateFailure,
  pullRequestRefForSession,
  resolvePullRequestWritePermission,
  runGuardedMetadataWrite,
  type PreparedMetadataWrite,
  type PullRequestMetadataListFailure,
  type PullRequestMetadataReadFailure,
  type PullRequestMetadataWriteFailure,
} from "./pull-request-metadata-write";

/** One label to add or remove; `name` travels alongside `id` purely so a confirmed write can journal a human-legible own-write fingerprint without a second lookup. */
type LabelRef = {
  readonly id: string;
  readonly name: string;
};

export type LabelCommand =
  | { readonly _tag: "AddLabels"; readonly labels: ReadonlyArray<LabelRef> }
  | { readonly _tag: "RemoveLabels"; readonly labels: ReadonlyArray<LabelRef> };

export type LabelReceipt =
  | { readonly _tag: "LabelsAdded"; readonly added: ReadonlyArray<string> }
  | { readonly _tag: "LabelsRemoved"; readonly removed: ReadonlyArray<string> };

/** Labels add no reason of their own to the shared metadata-write vocabulary. */
export type LabelWriteFailure = PullRequestMetadataWriteFailure;

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
  | PullRequestMetadataReadFailure;

/** Only the review-resolution half can fail the request outright; a GitHub read failure is conveyed as a `LabelListOutcome` instead. */
export type LabelListFailure = PullRequestMetadataListFailure;

type Gateway = Pick<
  GitHubReader,
  | "getPullRequest"
  | "resolveAuthenticatedAccount"
  | "getRepositoryPermission"
  | "listRepositoryLabels"
> &
  Pick<
    GitHubReviewWriter,
    "addLabelsToLabelable" | "removeLabelsFromLabelable"
  >;

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
    private readonly operations: Pick<
      ReviewWriteOperationStore,
      "load" | "begin" | "markOutcomeUnknown" | "confirm" | "reject" | "remove"
    >,
  ) {}

  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: LabelCommand;
  }): Promise<Result<LabelReceipt, LabelWriteFailure>> {
    return await runGuardedMetadataWrite<LabelReceipt, LabelWriteFailure>({
      profileId: input.profileId,
      reviewId: input.reviewId,
      coordinator: this.writeCoordinator,
      operations: this.operations,
      recentWrites: this.recentWrites,
      now: this.now,
      validate: () => validateLocalCommand(input.command),
      prepare: () => this.prepareWrite(input),
      journalEntry: journalEntryFor,
    });
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
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);
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
        : mapGitHubReadFailure(listed.error),
    );
  }

  /**
   * The label-specific half of permission resolution: label management is
   * what GitHub's `triage` role grants without pull-request write, so this
   * projects the shared evidence through `repositoryLabelPermission` rather
   * than the pull-request-write projection its sibling services use. See
   * ADR "The conversation rail owns pull request metadata writes".
   */
  private async resolveLabelPermission(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<RepositoryLabelPermission> {
    return await resolvePullRequestWritePermission({
      github: this.github,
      profile,
      pr,
      project: repositoryLabelPermission,
    });
  }

  private async prepareWrite(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: LabelCommand;
  }): Promise<
    Result<
      PreparedMetadataWrite<LabelReceipt, LabelWriteFailure>,
      LabelWriteFailure
    >
  > {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);

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
      const writer = this.github.addLabelsToLabelable.bind(this.github);
      return ok({
        sessionId: current.value.session.id,
        intent: { _tag: "AddLabels" as const, names: labelNames },
        write: async (): Promise<Result<LabelReceipt, LabelWriteFailure>> => {
          const written = await writer({
            profile: current.value.profile,
            labelableId,
            labelIds,
          });
          return written._tag === "err"
            ? err(mapGitHubWriteFailure(written.error))
            : ok({ _tag: "LabelsAdded", added: labelNames });
        },
      });
    }
    if (this.github.removeLabelsFromLabelable === undefined)
      return err("github_write_failed");
    const writer = this.github.removeLabelsFromLabelable.bind(this.github);
    return ok({
      sessionId: current.value.session.id,
      intent: { _tag: "RemoveLabels" as const, names: labelNames },
      write: async (): Promise<Result<LabelReceipt, LabelWriteFailure>> => {
        const written = await writer({
          profile: current.value.profile,
          labelableId,
          labelIds,
        });
        return written._tag === "err"
          ? err(mapGitHubWriteFailure(written.error))
          : ok({ _tag: "LabelsRemoved", removed: labelNames });
      },
    });
  }
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
