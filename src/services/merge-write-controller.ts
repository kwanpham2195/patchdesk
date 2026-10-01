import type {
  GitHubMergeWriter,
  GitHubReader,
} from "../adapters/github/github-adapter";
import type { InsightStore } from "../adapters/storage/insight-store";
import type {
  ReviewStore,
  ReviewStoreFailure,
} from "../adapters/storage/review-store";
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import {
  mergeGateFindings,
  type MergeGateFinding,
} from "../domain/analysis-merge-findings";
import type {
  MergeReadiness,
  MergeWarningCode,
} from "../domain/merge-readiness";
import type {
  ContentHash,
  GitSha,
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import {
  confirmMergeOperation,
  markMergeOutcomeUnknown,
  rejectMergeOperation,
  requestMergeOperation,
  type MergeOperation,
} from "../domain/merge-operation";
import { definedProps } from "../domain/defined-props";
import { markReviewTerminal, type Review } from "../domain/review";
import { err, ok, type Result } from "../domain/result";
import { parseReviewResult } from "../domain/review-result";
import type { PullRequestReviewSession } from "../domain/review-session";
import {
  postDesktopNotification,
  type DesktopNotifier,
} from "./desktop-notifier";
import type { AppLogService } from "./app-log-service";
import type { MergeMethod } from "../domain/github-context";
import { mergePullRequest, type MergeFailure } from "./merge-service";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type {
  ReviewWriteGate,
  ReviewWriteGateFailure,
} from "./review-write-gate";

/** A merge request the route has already parsed and branded, so the controller checks policy only. */
export type MergeCommand = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly expectedHeadSha: GitSha;
  readonly expectedBaseSha: GitSha;
  readonly expectedPatchHash: ContentHash;
  readonly expectedRevision: IsoTimestamp;
  readonly method: MergeMethod;
  readonly acknowledgedWarnings: {
    readonly revision: {
      readonly headSha: string;
      readonly baseSha: string;
      readonly patchHash: string;
    };
    readonly warningCodes: ReadonlyArray<MergeWarningCode>;
  };
};

/** What a confirmed merge answers with. */
type MergeWriteReceipt = {
  readonly readiness: MergeReadiness;
  readonly review: Review;
  readonly mergeCommitSha?: GitSha;
};

/** The merge response body: the renderer's strict receipt holds readiness and the merge commit, never the stored Review. */
export function mergeReceiptBody(receipt: MergeWriteReceipt): {
  readonly readiness: MergeReadiness;
  readonly mergeCommitSha?: GitSha;
} {
  return receipt.mergeCommitSha === undefined
    ? { readiness: receipt.readiness }
    : { readiness: receipt.readiness, mergeCommitSha: receipt.mergeCommitSha };
}

/** Every reason `MergeWriteController.merge` refuses or cannot confirm a merge. */
type MergeWriteFailure = {
  readonly reason:
    | ReviewWriteGateFailure["reason"]
    | MergeRejectionReason
    | "invalid_input"
    | "merge_in_progress"
    | "storage_failed"
    | "merge_outcome_unknown";
};

type MergeRejectionReason =
  | "merge_blocked"
  | "merge_acknowledgement_required"
  | "stale_head"
  | "not_fresh"
  | "merge_method_not_allowed"
  | "merge_not_mergeable"
  | "merge_head_changed"
  | "merge_rate_limited"
  | "merge_forbidden"
  | "merge_failed";

/** Main-process merge boundary; the renderer supplies only an already-confirmed method and acknowledgement. */
export class MergeWriteController {
  constructor(
    private readonly github: Pick<
      GitHubReader,
      | "getMergeOutcome"
      | "getMergePolicy"
      | "getPullRequest"
      | "getPullRequestDiff"
    > &
      GitHubMergeWriter,
    private readonly now: () => IsoTimestamp,
    private readonly operations: MergeOperationStore,
    private readonly writeGate: ReviewWriteGate,
    /** The two durable Review stores this merge reads, grouped as one dependency. */
    private readonly stores: {
      readonly reviews: Pick<ReviewStore, "load" | "save">;
      readonly insights: Pick<InsightStore, "loadTyped">;
    },
    private readonly writeCoordinator: ReviewOperationCoordinator,
    private readonly notifier?: DesktopNotifier,
    private readonly log?: Pick<AppLogService, "write">,
  ) {}

  /** Merges once the gate, the represented revision, and the acknowledgement all match what the maintainer confirmed. */
  async merge(
    input: MergeCommand,
  ): Promise<Result<MergeWriteReceipt, MergeWriteFailure>> {
    const {
      profileId,
      reviewId,
      sessionId,
      expectedHeadSha,
      expectedBaseSha,
      expectedPatchHash,
      expectedRevision,
      method,
    } = input;
    const acknowledgedWarningCodes = warningCodesForRevision(input);
    if (acknowledgedWarningCodes === undefined)
      return err({ reason: "invalid_input" });
    const key = `${profileId}:${reviewId}`;
    const acquired = this.writeCoordinator.acquire(key);
    if (!acquired) return err({ reason: "merge_in_progress" });
    try {
      const gated = await this.writeGate.requireFresh(profileId, reviewId, {
        sessionId,
        headSha: expectedHeadSha,
        patchHash: expectedPatchHash,
      });
      if (gated._tag === "err") return err({ reason: gated.error.reason });
      if (
        gated.value.review.representedRemote?.refreshedAt !== expectedRevision
      )
        return err({ reason: "stale" });
      if (gated.value.session.pr.baseSha !== expectedBaseSha)
        return err({ reason: "stale" });
      const [profile, session] = [
        ok(gated.value.profile),
        ok(gated.value.session),
      ] as const;
      if (profile._tag === "err" || session._tag === "err")
        return err({ reason: "not_found" });
      const findings = await this.currentAnalysisFindings(
        profileId,
        reviewId,
        {
          sessionId,
          headSha: expectedHeadSha,
          patchHash: expectedPatchHash,
        },
        session.value.findingReviewReceipts,
      );
      if (findings._tag === "err") return err({ reason: "storage_failed" });
      const startedAt = this.now();
      const requested = requestMergeOperation({
        operationId: `merge-${startedAt.replace(/[^0-9]/g, "")}`,
        profileId: profileId,
        reviewId: reviewId,
        sessionId,
        pr: {
          host: session.value.key.host,
          owner: session.value.key.owner,
          repo: session.value.key.repo,
          number: session.value.key.source.prNumber,
        },
        expectedHeadSha: session.value.key.headSha,
        method,
        acknowledgedWarningCodes: acknowledgedWarningCodes,
        startedAt,
      });
      if (requested._tag === "err") return err({ reason: "invalid_input" });
      const begun = await this.operations.begin(requested.value);
      if (begun._tag === "err")
        return err({
          reason:
            begun.error._tag === "MergeOperationExists"
              ? "merge_outcome_unknown"
              : "storage_failed",
        });
      const unknown = markMergeOutcomeUnknown(requested.value);
      if (
        unknown._tag === "err" ||
        (await this.operations.markOutcomeUnknown(unknown.value))._tag === "err"
      )
        return err({ reason: "storage_failed" });
      const merged = await mergePullRequest({
        profile: profile.value,
        session: session.value,
        result: { findings: findings.value },
        gateway: this.github,
        method,
        acknowledgedWarningCodes: acknowledgedWarningCodes,
      });
      if (merged._tag === "err") {
        if (merged.error._tag === "GitHubMergeOutcomeUnknown") {
          this.notifyNeedsRecovery(requested.value);
          return err({ reason: "merge_outcome_unknown" });
        }
        const reason = mergeReason(merged.error);
        const rejected = rejectMergeOperation(unknown.value, reason);
        // An unrecorded rejection leaves this operation outcome-unknown on disk, still locking the Review.
        if (
          rejected._tag === "err" ||
          (await this.operations.reject(rejected.value))._tag === "err"
        )
          this.notifyNeedsRecovery(requested.value);
        return err({ reason });
      }
      const confirmed = confirmMergeOperation(
        unknown.value,
        startedAt,
        merged.value.mergeCommitSha,
      );
      if (
        confirmed._tag === "err" ||
        (await this.operations.confirm(confirmed.value))._tag === "err"
      ) {
        this.notifyNeedsRecovery(requested.value);
        return err({ reason: "merge_outcome_unknown" });
      }
      const terminalReview = await this.recordMergedReview(
        confirmed.value,
        gated.value.review,
      );
      postDesktopNotification(this.notifier, {
        _tag: "MergeCompleted",
        reviewId,
        pullRequest: requested.value.pr,
      });
      return ok({
        readiness: merged.value.readiness,
        review: terminalReview,
        ...definedProps({ mergeCommitSha: merged.value.mergeCommitSha }),
      });
    } finally {
      this.writeCoordinator.release(key);
    }
  }

  // Only this call's own operation notifies; `MergeOperationExists` is an older lock that already did.
  private notifyNeedsRecovery(operation: MergeOperation): void {
    postDesktopNotification(this.notifier, {
      _tag: "WriteNeedsRecovery",
      reviewId: operation.reviewId,
      pullRequest: operation.pr,
    });
  }

  /**
   * Marks the Review merged and drops the confirmed receipt. GitHub already
   * merged, so a failure here is logged and left for startup recovery, which
   * reconciles any Confirmed operation still on disk.
   */
  private async recordMergedReview(
    operation: MergeOperation,
    gatedReview: Review,
  ): Promise<Review> {
    const { profileId, reviewId, sessionId, startedAt } = operation;
    const current = await this.stores.reviews.load(profileId, reviewId);
    if (current._tag === "err") {
      this.logBookkeepingFailure(operation, "review load", current.error);
      return markReviewTerminal(gatedReview, "merged", startedAt);
    }
    const terminal = markReviewTerminal(current.value, "merged", startedAt);
    const saved = await this.stores.reviews.save(
      terminal,
      current.value.updatedAt,
    );
    // The receipt stays until the terminal Review is on disk, so recovery can still finish it.
    if (saved._tag === "err") {
      this.logBookkeepingFailure(
        operation,
        "terminal review save",
        saved.error,
      );
      return terminal;
    }
    const removed = await this.operations.removeAfterSessionReceipt(
      profileId,
      sessionId,
    );
    if (removed._tag === "err")
      this.logBookkeepingFailure(operation, "receipt removal", removed.error);
    return terminal;
  }

  private logBookkeepingFailure(
    operation: MergeOperation,
    step: string,
    failure: ReviewStoreFailure,
  ): void {
    this.log?.write({
      process: "main",
      level: "error",
      topic: "merge",
      message: `confirmed merge ${step} failed; left for recovery`,
      profileId: operation.profileId,
      sessionId: operation.sessionId,
      meta: {
        reviewId: operation.reviewId,
        operationId: operation.operationId,
        tag: failure._tag,
        reason: failure.reason,
      },
    });
  }

  /**
   * The Analysis Findings this merge must answer for. Without them the gate's
   * Analysis rules -- the profile's merge policy and the high-severity
   * acknowledgement -- decide on an empty Finding list and can never fire, so
   * a merge the Workbench badge blocks would still go through.
   *
   * A missing or schema-drifted Insight reads as "no Analysis", exactly as the
   * Workbench projection reads it, so a corrupt record never silently refuses
   * a merge. Any other storage failure is reported instead of guessed at.
   */
  private async currentAnalysisFindings(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    revision: {
      readonly sessionId: ReviewSessionId;
      readonly headSha: GitSha;
      readonly patchHash: ContentHash;
    },
    receipts: PullRequestReviewSession["findingReviewReceipts"],
  ): Promise<
    Result<ReadonlyArray<MergeGateFinding>, { readonly reason: string }>
  > {
    const analysis = await this.stores.insights.loadTyped(
      profileId,
      reviewId,
      "analysis",
      (input) => parseReviewResult(input),
    );
    if (analysis._tag === "err")
      return analysis.error.reason === "not_found" ||
        analysis.error.reason === "invalid_stored_value"
        ? ok([])
        : err({ reason: "storage_failed" });
    return ok(mergeGateFindings(analysis.value, revision, receipts));
  }
}

/** The acknowledged warning codes, de-duplicated and sorted, when the acknowledgement names the revision being merged. */
function warningCodesForRevision(
  command: MergeCommand,
): ReadonlyArray<MergeWarningCode> | undefined {
  const { revision, warningCodes } = command.acknowledgedWarnings;
  return revision.headSha === command.expectedHeadSha &&
    revision.baseSha === command.expectedBaseSha &&
    revision.patchHash === command.expectedPatchHash
    ? [...new Set(warningCodes)].sort()
    : undefined;
}

/** The wire reason for every merge failure that left nothing merged; exported for direct unit testing of the mapping. */
export function mergeReason(failure: MergeFailure): MergeRejectionReason {
  switch (failure._tag) {
    case "MergeBlocked":
      return "merge_blocked";
    case "MergeAcknowledgementRequired":
      return "merge_acknowledgement_required";
    case "StaleHeadBlocksMerge":
    case "RevisionChangedBlocksMerge":
      return "stale_head";
    case "RevisionUnavailableBlocksMerge":
      return "not_fresh";
    case "MergeMethodNotAllowed":
      return "merge_method_not_allowed";
    case "GitHubMergeRefused":
      return failure.reason === "head_changed"
        ? "merge_head_changed"
        : "merge_not_mergeable";
    case "GitHubMergeRateLimited":
      return "merge_rate_limited";
    case "GitHubMergeForbidden":
      return "merge_forbidden";
    case "GitHubMergeReadFailed":
    case "GitHubMergeRejected":
    case "GitHubMergeOutcomeUnknown":
      return "merge_failed";
  }
}
