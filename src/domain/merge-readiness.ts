import type { CheckSummary } from "./github-context";
import type { AnalysisMergePolicy } from "./workspace-profile";

export type MergeReadiness = {
  readonly _tag: "Ready" | "Blocked" | "NeedsAcknowledgement";
  readonly blockers: ReadonlyArray<
    | "stale_head"
    | "closed"
    | "draft"
    | "conflicting"
    | "merge_blocked"
    | "mergeability_unknown"
    | "required_check"
    | "github_review"
    | "analysis_finding"
  >;
  readonly warnings: ReadonlyArray<"request_changes" | "high_severity_finding" | "analysis_finding">;
};

/** Decide only GitHub/PR hard blockers; executing a merge remains outside the domain layer. */
export function evaluateMergeReadiness(input: {
  readonly isCurrentHead: boolean;
  readonly isOpen: boolean;
  readonly isDraft: boolean;
  readonly mergeability: "mergeable" | "conflicting" | "blocked" | "unknown";
  readonly checks: CheckSummary;
  readonly hasGitHubReviewBlocker: boolean;
  readonly hasRequestChanges: boolean;
  readonly hasHighSeverityFinding: boolean;
  readonly analysisFindingCount?: number;
  readonly analysisMergePolicy?: AnalysisMergePolicy;
  readonly analysisAcknowledged?: boolean;
}): MergeReadiness {
  const blockers: Array<MergeReadiness["blockers"][number]> = [];
  if (!input.isCurrentHead) blockers.push("stale_head");
  if (!input.isOpen) blockers.push("closed");
  if (input.isDraft) blockers.push("draft");
  if (input.mergeability === "conflicting") blockers.push("conflicting");
  if (input.mergeability === "blocked") blockers.push("merge_blocked");
  if (input.mergeability === "unknown") blockers.push("mergeability_unknown");
  if (hasBlockingRequiredCheck(input.checks)) blockers.push("required_check");
  if (input.hasGitHubReviewBlocker) blockers.push("github_review");
  const analysisFindingCount = input.analysisFindingCount ?? 0;
  const analysisPolicy = input.analysisMergePolicy ?? "advisory";
  if (analysisFindingCount > 0 && analysisPolicy === "block") blockers.push("analysis_finding");

  const warnings: Array<MergeReadiness["warnings"][number]> = [];
  if (input.hasRequestChanges) warnings.push("request_changes");
  if (input.hasHighSeverityFinding) warnings.push("high_severity_finding");
  if (analysisFindingCount > 0 && analysisPolicy === "advisory") warnings.push("analysis_finding");
  if (analysisFindingCount > 0 && analysisPolicy === "require_acknowledgement" && input.analysisAcknowledged !== true) warnings.push("analysis_finding");
  return {
    _tag: blockers.length > 0 ? "Blocked" : warnings.length > 0 ? "NeedsAcknowledgement" : "Ready",
    blockers,
    warnings,
  };
}

function hasBlockingRequiredCheck(checks: CheckSummary): boolean {
  return checks.checks.some(
    (check) =>
      check.required === "unknown" ||
      (check.required === true &&
        (check.status !== "completed" || check.conclusion !== "success")),
  );
}
