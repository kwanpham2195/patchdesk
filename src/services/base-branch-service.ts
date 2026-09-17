import { pullRequestWritePermission } from "../adapters/github/github-adapter";
import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { ConfirmedWriteJournal } from "../adapters/storage/recent-write-journal-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type { PullRequestAssigneePermission } from "../domain/github-context";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import { definedProps } from "../domain/defined-props";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewWriteGate } from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { DesktopNotifier } from "./desktop-notifier";
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

/** Move the pull request onto another branch of its base repository. */
export type BaseBranchCommand = {
  readonly _tag: "SetBaseBranch";
  readonly branch: string;
};

/** GitHub accepted the base change; the Review still represents the old base until it refreshes. */
export type BaseBranchReceipt = {
  readonly _tag: "BaseBranchChanged";
  readonly branch: string;
};

/** The base change adds no reason of its own to the shared metadata-write vocabulary. */
export type BaseBranchWriteFailure = PullRequestMetadataWriteFailure;

/**
 * The branch picker's read: the pull request's current base, up to 100
 * candidate branches, their total for truncation, and the write permission.
 */
export type BaseBranchListOutcome =
  | {
      readonly _tag: "ready";
      readonly current: string;
      readonly branches: ReadonlyArray<string>;
      readonly branchesTotalCount: number;
      readonly permission: PullRequestAssigneePermission;
    }
  | PullRequestMetadataReadFailure;

/** Only the review-resolution half fails the read outright. */
export type BaseBranchListFailure = PullRequestMetadataListFailure;

type Gateway = Pick<
  GitHubReader,
  | "getPullRequest"
  | "listRepositoryBranches"
  | "resolveAuthenticatedAccount"
  | "getRepositoryPermission"
> &
  Pick<GitHubReviewWriter, "setPullRequestBaseBranch">;

/**
 * Owns the base-branch change for one current Review. It gates on
 * `requireCurrentSession` (ADR 0025) because a push while the maintainer
 * picks a branch does not make the change wrong; the Refresh that follows
 * reconciles the patch.
 *
 * `prepareWrite` refuses the branch the pull request already targets so a
 * maintainer never spends a GitHub write on a change that alters nothing.
 */
export class BaseBranchService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireCurrentSession">,
    private readonly github: Gateway,
    private readonly writeCoordinator: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp,
    private readonly recentWrites: ConfirmedWriteJournal,
    private readonly operations: Pick<
      ReviewWriteOperationStore,
      "load" | "begin" | "markOutcomeUnknown" | "confirm" | "reject" | "remove"
    >,
    private readonly notifier?: DesktopNotifier,
  ) {}

  /** Change the base branch through the guarded metadata-write path. */
  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: BaseBranchCommand;
  }): Promise<Result<BaseBranchReceipt, BaseBranchWriteFailure>> {
    return await runGuardedMetadataWrite<
      BaseBranchReceipt,
      BaseBranchWriteFailure
    >({
      profileId: input.profileId,
      reviewId: input.reviewId,
      coordinator: this.writeCoordinator,
      operations: this.operations,
      recentWrites: this.recentWrites,
      now: this.now,
      validate: () =>
        input.command.branch.trim().length === 0
          ? err("invalid_input")
          : ok(undefined),
      prepare: () => this.prepareWrite(input),
      notifier: this.notifier,
      journalEntry: (receipt) => ({
        _tag: "BaseBranchChange",
        branch: receipt.branch,
      }),
    });
  }

  /** Read the current base, candidate branches filtered by `query`, and permission. */
  async list(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly query?: string;
  }): Promise<Result<BaseBranchListOutcome, BaseBranchListFailure>> {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);
    const [pullRequest, branches, permission] = await Promise.all([
      this.github.getPullRequest({ profile: current.value.profile, pr }),
      this.github.listRepositoryBranches({
        profile: current.value.profile,
        repo: pr,
        ...definedProps({ query: input.query }),
      }),
      this.resolvePermission(current.value.profile, pr),
    ]);
    if (pullRequest._tag === "err")
      return ok(mapGitHubReadFailure(pullRequest.error));
    if (branches._tag === "err")
      return ok(mapGitHubReadFailure(branches.error));
    return ok({
      _tag: "ready",
      current: pullRequest.value.baseBranch,
      branches: branches.value.branches,
      branchesTotalCount: branches.value.totalCount,
      permission,
    });
  }

  private async resolvePermission(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<PullRequestAssigneePermission> {
    return await resolvePullRequestWritePermission({
      github: this.github,
      profile,
      pr,
      project: pullRequestWritePermission,
    });
  }

  private async prepareWrite(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: BaseBranchCommand;
  }): Promise<
    Result<
      PreparedMetadataWrite<BaseBranchReceipt, BaseBranchWriteFailure>,
      BaseBranchWriteFailure
    >
  > {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);

    const permission = await this.resolvePermission(current.value.profile, pr);
    if (permission !== "permitted") return err("permission_denied");

    const pullRequest = await this.github.getPullRequest({
      profile: current.value.profile,
      pr,
    });
    if (pullRequest._tag === "err") return err("github_read_failed");
    const pullRequestId = pullRequest.value.nodeId;
    if (pullRequestId === undefined) return err("github_read_failed");
    const branch = input.command.branch;
    if (pullRequest.value.baseBranch === branch) return err("invalid_input");

    if (this.github.setPullRequestBaseBranch === undefined)
      return err("github_write_failed");
    const writer = this.github.setPullRequestBaseBranch.bind(this.github);
    return ok({
      sessionId: current.value.session.id,
      pullRequest: pr,
      intent: { _tag: "SetBaseBranch" as const, branch },
      write: async (): Promise<
        Result<BaseBranchReceipt, BaseBranchWriteFailure>
      > => {
        const written = await writer({
          profile: current.value.profile,
          pullRequestId,
          branch,
        });
        return written._tag === "err"
          ? err(mapGitHubWriteFailure(written.error))
          : ok({ _tag: "BaseBranchChanged", branch });
      },
    });
  }
}
