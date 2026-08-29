import type { ContentHash } from "./ids";
import type { InsightProjection } from "./insight";
import {
  isPendingReviewLocked,
  type PendingReviewState,
} from "./pending-review";
import type { ReviewResult } from "./review-result";
import type { ReviewSession } from "./review-session";

/**
 * How fresh the projected revision is against its pull request, as the
 * workbench renders it. `ReviewWorkbenchProjection["revision"]["freshness"]`
 * is this type; it is named here so the pure projection below can state its
 * own input without importing back into `src/services`.
 */
export type WorkbenchRevisionFreshness =
  | "fresh"
  | "updates_available"
  | "unavailable"
  | "not_refreshed";

type AnalysisFindingReviewStatus =
  | { readonly state: "actionable" }
  | { readonly state: "pending_review" }
  | { readonly state: "published" }
  | { readonly state: "locked" };

export type AnalysisReviewActionsProjection = {
  readonly findings: Readonly<Record<string, AnalysisFindingReviewStatus>>;
  readonly canFinishWithAnalysisSummary: boolean;
};

export function projectAnalysisReviewActions(input: {
  readonly analysis: InsightProjection<ReviewResult>;
  readonly session: ReviewSession;
  readonly freshness: WorkbenchRevisionFreshness;
  readonly patchHash: ContentHash | undefined;
  readonly pendingReview: PendingReviewState | undefined;
}): AnalysisReviewActionsProjection {
  const retained = input.analysis.retained;
  const current =
    retained !== undefined &&
    retained.runId !== undefined &&
    input.analysis.status === "current" &&
    input.analysis.artifactStatus === "verified" &&
    input.freshness === "fresh" &&
    input.patchHash !== undefined &&
    retained.sessionId === input.session.id &&
    retained.headSha === input.session.key.headSha;
  if (
    !current ||
    retained === undefined ||
    retained.runId === undefined ||
    input.patchHash === undefined
  )
    return { findings: {}, canFinishWithAnalysisSummary: false };
  const locked = isPendingReviewLocked(input.pendingReview);
  const receipts = input.session.findingReviewReceipts ?? [];
  const findings: Record<string, AnalysisFindingReviewStatus> = {};
  for (const finding of retained.value.findings) {
    if (finding.disposition === "dismissed") continue;
    const receipt = receipts.find(
      (candidate) =>
        candidate.analysisRunId === retained.runId &&
        candidate.findingId === finding.id &&
        candidate.sessionId === input.session.id &&
        candidate.headSha === input.session.key.headSha &&
        candidate.patchHash === input.patchHash,
    );
    const unresolved =
      input.pendingReview?._tag === "Pending" &&
      input.pendingReview.unresolvedFinding?.analysisRunId === retained.runId &&
      input.pendingReview.unresolvedFinding.findingId === finding.id &&
      input.pendingReview.unresolvedFinding.sessionId === input.session.id &&
      input.pendingReview.unresolvedFinding.headSha ===
        input.session.key.headSha &&
      input.pendingReview.unresolvedFinding.patchHash === input.patchHash;
    findings[finding.id] =
      receipt === undefined
        ? locked || unresolved
          ? { state: "locked" }
          : { state: "actionable" }
        : receipt.state === "pending"
          ? { state: "pending_review" }
          : { state: "published" };
  }
  const pendingReviewNodeId =
    input.pendingReview?._tag === "Pending"
      ? input.pendingReview.review.nodeId
      : undefined;
  return {
    findings,
    canFinishWithAnalysisSummary:
      pendingReviewNodeId !== undefined &&
      receipts.some(
        (receipt) =>
          receipt.state === "pending" &&
          receipt.pendingReviewNodeId === pendingReviewNodeId &&
          receipt.analysisRunId === retained.runId &&
          receipt.sessionId === input.session.id &&
          receipt.headSha === input.session.key.headSha &&
          receipt.patchHash === input.patchHash,
      ),
  };
}
