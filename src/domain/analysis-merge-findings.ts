import type { ContentHash, FindingId, GitSha, ReviewSessionId } from "./ids";
import {
  sameInsightRevision,
  type InsightFindingDismissal,
  type InsightRecord,
  type RetainedInsight,
} from "./insight-record";
import type { ReviewResult } from "./review-result";
import type { AnalysisMergePolicy } from "./workspace-profile";

/** The three Finding fields the merge rule reads. */
export type MergeGateFinding = {
  readonly id: FindingId;
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly disposition?: "open" | "dismissed";
};

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
 * it belongs to the exact revision being merged, with its dismissals applied.
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
): ReviewResult["findings"] {
  const patchHash = revision.patchHash;
  if (record === undefined || patchHash === undefined) return [];
  const retained = record.retained;
  if (retained === undefined) return [];
  return sameInsightRevision(retained.revision, {
    sessionId: revision.sessionId,
    headSha: revision.headSha,
    patchHash,
  })
    ? projectAnalysisFindings(retained.value, record).findings
    : [];
}

/**
 * The Analysis half of `evaluateMergeReadiness`'s input, listed in one place.
 *
 * Only an *open* P0 or P1 Finding affects merge, per the ADR "Make Analysis
 * merge policy configurable": "Under the Block policy, only open P0 or P1
 * Findings block merge." A dismissed Finding is not open, so it neither blocks
 * a merge nor asks the maintainer to acknowledge it.
 */
export function analysisMergeInput(
  findings: ReadonlyArray<MergeGateFinding>,
  policy: AnalysisMergePolicy | undefined,
) {
  const openHighSeverityFindingIds = findings
    .filter(
      (finding) =>
        finding.disposition !== "dismissed" &&
        (finding.severity === "P0" || finding.severity === "P1"),
    )
    .map((finding) => finding.id);
  const listed = { openHighSeverityFindingIds };
  return policy === undefined
    ? listed
    : { ...listed, analysisMergePolicy: policy };
}
