import type {
  GitHubMergeWriter,
  GitHubReader,
} from "../adapters/github/github-adapter";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { ReviewStore } from "../adapters/storage/review-store";
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
} from "../domain/merge-operation";
import { markReviewTerminal, type Review } from "../domain/review";
import { err, ok, type Result } from "../domain/result";
import { parseReviewResult } from "../domain/review-result";
import type { ReviewSession } from "../domain/review-session";
import { mergePullRequest, type MergeMethod } from "./merge-service";
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
};

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
  | "merge_rate_limited"
  | "merge_forbidden"
  | "merge_failed";

/** Main-process merge boundary; the renderer supplies only an already-confirmed method and acknowledgement. */
export class MergeWriteController {
  constructor(
    private readonly github: Pick<
      GitHubReader,
      "getMergePolicy" | "getPullRequest" | "getPullRequestDiff"
    > &
      GitHubMergeWriter,
    private readonly methods: ReadonlyArray<MergeMethod>,
    private readonly now: () => IsoTimestamp,
    private readonly operations: MergeOperationStore,
    private readonly writeGate: ReviewWriteGate,
    /** The two durable Review stores this merge reads, grouped as one dependency. */
    private readonly stores: {
      readonly reviews: Pick<ReviewStore, "load" | "save">;
      readonly insights: Pick<InsightStore, "loadTyped">;
    },
    private readonly writeCoordinator: ReviewOperationCoordinator,
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
          number: session.value.key.prNumber,
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
        supportedMethods: this.methods,
        acknowledgedWarningCodes: acknowledgedWarningCodes,
      });
      if (merged._tag === "err") {
        if (merged.error._tag === "GitHubMergeOutcomeUnknown")
          return err({ reason: "merge_outcome_unknown" });
        const rejected = rejectMergeOperation(
          unknown.value,
          mergeReason(merged.error._tag),
        );
        if (rejected._tag === "ok")
          await this.operations.reject(rejected.value);
        return err({ reason: mergeReason(merged.error._tag) });
      }
      const confirmed = confirmMergeOperation(
        unknown.value,
        startedAt,
        merged.value.mergeCommitSha,
      );
      if (
        confirmed._tag === "err" ||
        (await this.operations.confirm(confirmed.value))._tag === "err"
      )
        return err({ reason: "merge_outcome_unknown" });
      const currentReview = await this.stores.reviews.load(
        profileId,
        requested.value.reviewId,
      );
      if (currentReview._tag !== "ok")
        return err({ reason: "merge_outcome_unknown" });
      const terminalReview = markReviewTerminal(
        currentReview.value,
        "merged",
        startedAt,
      );
      const savedReview = await this.stores.reviews.save(
        terminalReview,
        currentReview.value.updatedAt,
      );
      if (savedReview._tag === "err")
        return err({ reason: "merge_outcome_unknown" });
      const removed = await this.operations.removeAfterSessionReceipt(
        profileId,
        sessionId,
      );
      return removed._tag === "ok"
        ? ok({ readiness: merged.value.readiness, review: terminalReview })
        : err({ reason: "merge_outcome_unknown" });
    } finally {
      this.writeCoordinator.release(key);
    }
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
    receipts: ReviewSession["findingReviewReceipts"],
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

/** Exported for direct unit testing of the tag-to-wire-reason mapping without module-mocking merge-service.ts. */
export function mergeReason(tag: string): MergeRejectionReason {
  return tag === "MergeBlocked"
    ? "merge_blocked"
    : tag === "MergeAcknowledgementRequired"
      ? "merge_acknowledgement_required"
      : tag === "StaleHeadBlocksMerge" || tag === "RevisionChangedBlocksMerge"
        ? "stale_head"
        : tag === "RevisionUnavailableBlocksMerge"
          ? "not_fresh"
          : tag === "GitHubMergeRateLimited"
            ? "merge_rate_limited"
            : tag === "GitHubMergeForbidden"
              ? "merge_forbidden"
              : "merge_failed";
}
