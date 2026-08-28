import type {
  CheckRunSummary,
  CheckSummary,
  GitHubMergeEvidence,
  MergeDisplayReason,
} from "./github-context";
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
  return blockingRequiredChecks(checks).length > 0;
}

function blockingRequiredChecks(
  checks: CheckSummary,
): ReadonlyArray<CheckRunSummary> {
  return checks.checks.filter(
    (check) =>
      check.required === true &&
      (check.status !== "completed" || check.conclusion !== "success"),
  );
}

/**
 * The checks half of the merge-readiness rule, written as panel reasons.
 *
 * It reads the same `blockingRequiredChecks` predicate the `required_check`
 * blocker reads, and returns at least one reason whenever that predicate
 * matches anything. So a Blocked badge carrying `required_check` can never
 * sit above a panel with nothing to say about checks — the empty-panel case
 * the ADR "Derive merge readiness from applied rules" rules out is closed by
 * construction rather than by matching two independent conditions.
 */
export function deriveCheckReasons(
  checks: CheckSummary,
): ReadonlyArray<MergeDisplayReason> {
  const blocking = blockingRequiredChecks(checks);
  const failed = blocking.filter((check) => check.status === "completed");
  const unfinished = blocking.filter((check) => check.status !== "completed");
  const reasons: Array<MergeDisplayReason> = [];
  // A required check GitHub has not finished running is a known fact about
  // the policy, not an undeterminable one, so it is stated plainly — but as
  // "has not finished", never as a failure it has not suffered.
  if (failed.length > 0)
    reasons.push(checkReason(`Required ${nameList(failed)} did not pass.`));
  if (unfinished.length > 0)
    reasons.push(
      checkReason(
        `Required ${nameList(unfinished)} ${unfinished.length === 1 ? "has" : "have"} not finished.`,
      ),
    );
  // A red rollup with nothing required is `unstable` in GitHub's own terms —
  // mergeable with a non-passing commit status — so this must not claim a
  // requirement it can see is absent. It is still reported, because the badge
  // reports the same rollup as `failing_check`.
  if (reasons.length === 0 && checks.overall === "failing")
    reasons.push(checkReason("A check on this pull request did not pass."));
  return reasons;
}

function nameList(checks: ReadonlyArray<CheckRunSummary>): string {
  const names = checks.map((check) => check.name);
  const label = names.length === 1 ? "check" : "checks";
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length - 3;
  return rest > 0 ? `${label} ${shown} and ${rest} more` : `${label} ${shown}`;
}

function checkReason(message: string): MergeDisplayReason {
  return {
    code: "checks",
    message,
    source: "checks",
    availability: "available",
    openOnGitHub: false,
  };
}

/**
 * `mergeable` answers only "does this branch apply cleanly"; the rule-level
 * verdict lives in `mergeStateStatus`. Folding both into the one mergeability
 * `evaluateMergeReadiness` reads means every state that earns a reason card
 * earns a blocker.
 *
 * `mergePolicyComplete === false` overrides the fold outright -- the same
 * fail-closed rule the merge gate applies to the raw read
 * (`merge-service.ts`): `policy.value.complete ? policy.value.mergeability :
 * "unknown"`. An incomplete policy classified nothing reliably, so neither
 * surface may trust it further just because `mergeStateStatus` reads clean.
 * `undefined` means no merge-policy read was attempted at all, which is a
 * different, lower-confidence source this axis does not touch.
 */
export function readinessMergeability(
  aggregate: GitHubMergeEvidence,
  mergePolicyComplete?: boolean,
): "mergeable" | "conflicting" | "blocked" | "unknown" {
  if (mergePolicyComplete === false) return "unknown";
  const { mergeable, mergeStateStatus: status } = aggregate;
  if (mergeable === "conflicting" || status === "dirty") return "conflicting";
  if (mergeable === "blocked" || status === "blocked" || status === "behind")
    return "blocked";
  return mergeable;
}
