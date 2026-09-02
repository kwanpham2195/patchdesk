import type { ContentHash, FindingId, GitSha, ReviewSessionId } from "./ids";
import {
  sameInsightRevision,
  type InsightFindingDismissal,
  type InsightRecord,
  type RetainedInsight,
} from "./insight-record";
import type { FindingReviewReceipt } from "./pending-review";
import type { ReviewResult } from "./review-result";
import type { AnalysisMergePolicy } from "./workspace-profile";

/** The Finding fields the merge rule reads. */
export type MergeGateFinding = {
  readonly id: FindingId;
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly disposition?: "open" | "dismissed";
  /** True once the pending review carries a thread for this Finding. */
  readonly addedToReview?: boolean;
};

/**
 * Handled is one state: a Finding the maintainer dismissed or added to the
 * review has been answered, so neither merge readiness nor the Analysis
 * banner asks about it again. Both read this predicate, so their counts agree.
 */
export function isAnalysisFindingHandled(finding: {
  readonly disposition?: "open" | "dismissed" | undefined;
  readonly addedToReview?: boolean | undefined;
}): boolean {
  return finding.disposition === "dismissed" || finding.addedToReview === true;
}

/** Marks each Finding open or dismissed from the Insight record's dismissal list. */
export function projectAnalysisFindings(
  value: ReviewResult,
  record: InsightRecord<RetainedInsight<ReviewResult>>,
): ReviewResult {
  const dismissed = new Set(
    (record.dismissals ?? []).map(
      (entry: InsightFindingDismissal) => entry.findingId,
    ),
  );
  return {
    ...value,
    findings: value.findings.map((finding) => ({
      ...finding,
      disposition: dismissed.has(finding.id) ? "dismissed" : "open",
    })),
  };
}

/**
 * The Findings one merge must answer for: the retained Analysis, and only when
 * it belongs to the exact revision being merged, with its dismissals applied
 * and each Finding marked `addedToReview` when the session holds a review
 * receipt for it under this exact Analysis run and revision.
 *
 * The Workbench merge badge and the merge gate both read this function, so a
 * dismissed Finding is counted the same way on both sides -- the badge cannot
 * offer a merge the gate will refuse, and the gate cannot refuse a merge the
 * badge called ready. An outdated Analysis never affects merge, per the ADR
 * "Make Analysis merge policy configurable".
 */
export function mergeGateFindings(
  record: InsightRecord<RetainedInsight<ReviewResult>> | undefined,
  revision: {
    readonly sessionId: ReviewSessionId;
    readonly headSha: GitSha;
    readonly patchHash: ContentHash | undefined;
  },
  receipts: ReadonlyArray<FindingReviewReceipt> | undefined,
): ReadonlyArray<
  ReviewResult["findings"][number] & { readonly addedToReview: boolean }
> {
  const patchHash = revision.patchHash;
  if (record === undefined || patchHash === undefined) return [];
  const retained = record.retained;
  if (retained === undefined) return [];
  if (
    !sameInsightRevision(retained.revision, {
      sessionId: revision.sessionId,
      headSha: revision.headSha,
      patchHash,
    })
  )
    return [];
  // A receipt from another run or revision proves nothing about this Finding.
  const reviewed = new Set(
    (receipts ?? [])
      .filter(
        (receipt) =>
          receipt.analysisRunId === retained.runId &&
          receipt.sessionId === revision.sessionId &&
          receipt.headSha === revision.headSha &&
          receipt.patchHash === patchHash,
      )
      .map((receipt) => receipt.findingId),
  );
  return projectAnalysisFindings(retained.value, record).findings.map(
    (finding) => ({ ...finding, addedToReview: reviewed.has(finding.id) }),
  );
}

/**
 * The Analysis half of `evaluateMergeReadiness`'s input, listed in one place.
 *
 * Only an *open* P0 or P1 Finding affects merge, per the ADR "Make Analysis
 * merge policy configurable": "Under the Block policy, only open P0 or P1
 * Findings block merge." A handled Finding -- dismissed or already on the
 * review -- is not open, so it neither blocks a merge nor asks the maintainer
 * to acknowledge it.
 */
export function analysisMergeInput(
  findings: ReadonlyArray<MergeGateFinding>,
  policy: AnalysisMergePolicy | undefined,
) {
  const openHighSeverityFindingIds = findings
    .filter(
      (finding) =>
        !isAnalysisFindingHandled(finding) &&
        (finding.severity === "P0" || finding.severity === "P1"),
    )
    .map((finding) => finding.id);
  const listed = { openHighSeverityFindingIds };
  return policy === undefined
    ? listed
    : { ...listed, analysisMergePolicy: policy };
}
