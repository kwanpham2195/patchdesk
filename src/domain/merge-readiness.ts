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
    | "failing_check"
    | "github_review"
    | "analysis_finding"
  >;
  readonly warnings: ReadonlyArray<
    "request_changes" | "high_severity_finding" | "analysis_finding"
  >;
};

/** Decide only GitHub/PR hard blockers; executing a merge remains outside the domain layer. */
export function evaluateMergeReadiness(input: {
  readonly isCurrentHead: boolean;
  readonly isOpen: boolean;
  readonly isDraft: boolean;
  readonly mergeability: "mergeable" | "conflicting" | "blocked" | "unknown";
  readonly checks: CheckSummary;
  /**
   * Opt-in: block because the check rollup is red, whether or not GitHub says
   * any of those checks is required. Only the Workbench projection asks for
   * this, so that the merge badge cannot read "Ready" above a red checks card.
   * The merge gate leaves it unset — see `hasBlockingRequiredCheck` below.
   */
  readonly hasFailingChecks?: boolean;
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
  if (input.hasFailingChecks === true) blockers.push("failing_check");
  if (input.hasGitHubReviewBlocker) blockers.push("github_review");
  const analysisFindingCount = input.analysisFindingCount ?? 0;
  const analysisPolicy = input.analysisMergePolicy ?? "advisory";
  if (analysisFindingCount > 0 && analysisPolicy === "block")
    blockers.push("analysis_finding");

  const warnings: Array<MergeReadiness["warnings"][number]> = [];
  if (input.hasRequestChanges) warnings.push("request_changes");
  if (input.hasHighSeverityFinding) warnings.push("high_severity_finding");
  if (analysisFindingCount > 0 && analysisPolicy === "advisory")
    warnings.push("analysis_finding");
  if (
    analysisFindingCount > 0 &&
    analysisPolicy === "require_acknowledgement" &&
    input.analysisAcknowledged !== true
  )
    warnings.push("analysis_finding");
  return {
    _tag:
      blockers.length > 0
        ? "Blocked"
        : warnings.length > 0
          ? "NeedsAcknowledgement"
          : "Ready",
    blockers,
    warnings,
  };
}

// Only a check GitHub names as required, and has not passed, refuses a merge.
//
// A check whose required/not-required classification GitHub did not disclose
// is not, by itself, a blocker: per the ADR "Derive merge readiness from
// applied rules", a state Patchdesk cannot determine gets a neutral
// treatment, not the destructive one. A merge policy that could not be read
// completely already blocks through `mergeability: "unknown"`, so nothing is
// let through by treating unclassified checks as neutral here.
//
// A red check that GitHub does not require is not a blocker either. On a
// repository with no classic required-status-checks policy every check comes
// back `required: false`, and GitHub itself calls that pull request mergeable
// (`unstable`, "Mergeable with non-passing commit status"). The same ADR
// names that a mergeable state, not a blocker. Callers that want to surface a
// red rollup anyway ask for it with `hasFailingChecks`, which reports the
// separate `failing_check` blocker rather than claiming a check is required.
function hasBlockingRequiredCheck(checks: CheckSummary): boolean {
  return checks.checks.some(
    (check) =>
      check.required === true &&
      (check.status !== "completed" || check.conclusion !== "success"),
  );
}
