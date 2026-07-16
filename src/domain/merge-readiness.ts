import type { CheckSummary } from "./github-context";

export type MergeReadiness = {
  readonly _tag: "Ready" | "Blocked" | "NeedsAcknowledgement";
  readonly blockers: ReadonlyArray<"stale_head" | "closed" | "draft" | "conflicting" | "required_check" | "github_review">;
  readonly warnings: ReadonlyArray<"request_changes" | "high_severity_finding">;
};

/** Decide only GitHub/PR hard blockers; executing a merge remains outside the domain layer. */
export function evaluateMergeReadiness(input: {
  readonly isCurrentHead: boolean;
  readonly isOpen: boolean;
  readonly isDraft: boolean;
  readonly mergeability: "mergeable" | "conflicting" | "blocked" | "unknown";
  readonly checks: CheckSummary;
  readonly hasGitHubReviewBlocker: boolean;
}): MergeReadiness {
  const blockers: Array<MergeReadiness["blockers"][number]> = [];
  if (!input.isCurrentHead) blockers.push("stale_head");
  if (!input.isOpen) blockers.push("closed");
  if (input.isDraft) blockers.push("draft");
  if (input.mergeability !== "mergeable") blockers.push("conflicting");
  if (hasBlockingRequiredCheck(input.checks)) blockers.push("required_check");
  if (input.hasGitHubReviewBlocker) blockers.push("github_review");

  return { _tag: blockers.length === 0 ? "Ready" : "Blocked", blockers, warnings: [] };
}

function hasBlockingRequiredCheck(checks: CheckSummary): boolean {
  return checks.checks.some(
    (check) =>
      check.required === true &&
      (check.status !== "completed" || check.conclusion !== "success"),
  );
}
