import { pullRequestWritePermission } from "../adapters/github/github-adapter";
import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { ConfirmedWriteJournal } from "../adapters/storage/recent-write-journal-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type { PullRequestAssigneePermission } from "../domain/github-context";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewWriteGate } from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import {
  mapGitHubWriteFailure,
  mapMetadataGateFailure,
  pullRequestRefForSession,
  resolvePullRequestWritePermission,
  runGuardedMetadataWrite,
  type PreparedMetadataWrite,
  type PullRequestMetadataWriteFailure,
} from "./pull-request-metadata-write";

/** Ask GitHub to publish a draft for review (`draft: false`) or take a published pull request back to draft. */
export type DraftStateCommand = {
  readonly _tag: "SetDraftState";
  readonly draft: boolean;
};

export type DraftStateReceipt = {
  readonly _tag: "DraftStateChanged";
  readonly draft: boolean;
};

/** The draft toggle adds no reason of its own to the shared metadata-write vocabulary. */
export type DraftStateWriteFailure = PullRequestMetadataWriteFailure;

type Gateway = Pick<
  GitHubReader,
  "getPullRequest" | "resolveAuthenticatedAccount" | "getRepositoryPermission"
> &
  Pick<GitHubReviewWriter, "setPullRequestDraftState">;

/**
 * Owns the author-side draft toggle for one current Review. Draft state is
 * pull-request-level metadata, not diff-anchored, so this gates on
 * `requireCurrentSession` like every other metadata write — see ADR "The
 * conversation rail owns pull request metadata writes".
 *
 * Unlike labels, assignees, and `requestReviews` (all idempotent), neither
 * GraphQL draft mutation is: `markPullRequestReadyForReview` fails outright
 * on a pull request that is already not a draft. The mutation's refusal
 * arrives as a coarse write-failure category that cannot be told apart from
 * a genuine permission denial, so `prepareWrite` refuses the no-op on the
 * fresh read it already needs for the node id instead.
 */
export class DraftStateService {
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
  ) {}

  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: DraftStateCommand;
  }): Promise<Result<DraftStateReceipt, DraftStateWriteFailure>> {
    return await runGuardedMetadataWrite<
      DraftStateReceipt,
      DraftStateWriteFailure
    >({
      profileId: input.profileId,
      reviewId: input.reviewId,
      coordinator: this.writeCoordinator,
      operations: this.operations,
      recentWrites: this.recentWrites,
      now: this.now,
      // A boolean carries no local rule to break; the only rejection this
      // write has (the already-in-that-state no-op) needs the GitHub read
      // `prepareWrite` performs.
      validate: () => ok(undefined),
      prepare: () => this.prepareWrite(input),
      journalEntry: (receipt) => ({
        _tag: "DraftStateChange",
        draft: receipt.draft,
      }),
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
    readonly command: DraftStateCommand;
  }): Promise<
    Result<
      PreparedMetadataWrite<DraftStateReceipt, DraftStateWriteFailure>,
      DraftStateWriteFailure
    >
  > {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);

    // `unknown` permission evidence must never be treated as permitted; only
    // an explicit `permitted` proceeds, exactly as in `ReviewerService`.
    const permission = await this.resolvePermission(current.value.profile, pr);
    if (permission !== "permitted") return err("permission_denied");

    const pullRequest = await this.github.getPullRequest({
      profile: current.value.profile,
      pr,
    });
    if (pullRequest._tag === "err") return err("github_read_failed");
    const pullRequestId = pullRequest.value.nodeId;
    if (pullRequestId === undefined) return err("github_read_failed");
    const draft = input.command.draft;
    if (pullRequest.value.isDraft === draft) return err("invalid_input");

    if (this.github.setPullRequestDraftState === undefined)
      return err("github_write_failed");
    const writer = this.github.setPullRequestDraftState.bind(this.github);
    return ok({
      sessionId: current.value.session.id,
      intent: { _tag: "SetDraftState" as const, draft },
      write: async (): Promise<
        Result<DraftStateReceipt, DraftStateWriteFailure>
      > => {
        const written = await writer({
          profile: current.value.profile,
          pullRequestId,
          draft,
        });
        return written._tag === "err"
          ? err(mapGitHubWriteFailure(written.error))
          : ok({ _tag: "DraftStateChanged", draft });
      },
    });
  }
}
