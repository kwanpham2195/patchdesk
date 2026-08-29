import type {
  CheckSummary,
  GitHubMergeEvidence,
  MergeDisplayReason,
} from "./github-context";
import { deriveCheckReasons } from "./merge-readiness";

// Ordering: most-actionable-first. A maintainer reading this list top to
// bottom sees the reasons whose next action is on them (get another review,
// address feedback, resolve a named rule, update the branch, resolve
// conflicts, wait on a check) before the admittedly vague generic blocked
// fallback, which is pushed last and only when nothing more specific was
// already collected, so it never buries a real answer under a vague one.
export function deriveMergeReasons(
  aggregate: GitHubMergeEvidence | undefined,
  checks: CheckSummary,
): ReadonlyArray<MergeDisplayReason> {
  if (aggregate === undefined) return [];

  const branchProtection = aggregate.policy?.branchProtection;
  // Only a positive classic branch-protection count matches an approval
  // requirement. Zero and rules that do not expose approval configuration are
  // unavailable evidence, not an exact policy claim.
  const classicCount =
    branchProtection?.state === "available" &&
    branchProtection.value.requiredApprovingReviewCount !== undefined &&
    branchProtection.value.requiredApprovingReviewCount > 0
      ? branchProtection.value.requiredApprovingReviewCount
      : undefined;

  const appliedRuleset = aggregate.policy?.appliedRuleset;
  const pullRequestRule =
    appliedRuleset?.state === "available"
      ? appliedRuleset.value.rules.find(
          (rule) => rule.pullRequestParameters !== undefined,
        )?.pullRequestParameters
      : undefined;
  // Same "only a positive count is evidence" rule as classic protection.
  const rulesetCount =
    pullRequestRule?.requiredApprovingReviewCount !== undefined &&
    pullRequestRule.requiredApprovingReviewCount > 0
      ? pullRequestRule.requiredApprovingReviewCount
      : undefined;
  // Ruleset evidence is preferred: on a repo governed by Rulesets the classic
  // `branches/{branch}/protection` endpoint legitimately 404s, so a
  // ruleset-sourced count is the more direct evidence when both exist.
  const requiredCount = rulesetCount ?? classicCount;
  const requiredCountSource: MergeDisplayReason["source"] =
    rulesetCount === undefined ? "branch_protection" : "ruleset_configuration";

  const policyReadable =
    branchProtection?.state === "available" ||
    appliedRuleset?.state === "available";
  const blocked =
    aggregate.mergeStateStatus === "blocked" ||
    aggregate.mergeable === "blocked";

  const reasons: MergeDisplayReason[] = [];

  // `reviewDecision` reconciliation: GraphQL `reviewDecision` stays the gate
  // for whether a review is outstanding at all, because it reflects live
  // approval state no static ruleset field can express. It can under-report
  // (null, mapped to "unknown", on a ruleset-governed repo whose PR already
  // had a genuine approval) but never over-report, so ruleset evidence never
  // invents a requirement by itself — this branch stays gated strictly on
  // `review_required` — and only supplies a higher-confidence count/source
  // once the gate already says a review is outstanding.
  if (aggregate.reviewDecision === "review_required") {
    reasons.push({
      code: "review_required",
      message:
        requiredCount === undefined
          ? "Approval required by GitHub."
          : `${requiredCount} approving review${requiredCount === 1 ? "" : "s"} required by ${requiredCountSource === "ruleset_configuration" ? "ruleset configuration" : "branch protection"}.`,
      source:
        requiredCount === undefined ? "github_pr_state" : requiredCountSource,
      availability: requiredCount === undefined ? "partial" : "available",
      openOnGitHub: requiredCount === undefined,
    });
  } else if (aggregate.reviewDecision === "changes_requested") {
    reasons.push({
      code: "changes_requested",
      message: "Changes requested.",
      source: "github_pr_state",
      availability: "available",
      openOnGitHub: false,
    });
  }

  // GitHub says blocked and the ruleset says why: name the specific rules,
  // matching what GitHub's own UI renders for each.
  if (blocked && pullRequestRule?.requireLastPushApproval === true)
    reasons.push({
      code: "review_required",
      message:
        "New changes require approval from someone other than the last pusher.",
      source: "ruleset_configuration",
      availability: "available",
      openOnGitHub: false,
    });
  if (blocked && pullRequestRule?.requiredReviewThreadResolution === true)
    reasons.push({
      code: "blocked",
      message: "All review threads must be resolved before this can merge.",
      source: "ruleset_configuration",
      availability: "available",
      openOnGitHub: false,
    });

  if (aggregate.mergeStateStatus === "behind")
    reasons.push({
      code: "behind",
      message: "Update this branch with the base branch.",
      source: "github_pr_state",
      availability: "available",
      openOnGitHub: false,
    });

  if (
    aggregate.mergeStateStatus === "dirty" ||
    aggregate.mergeable === "conflicting"
  )
    reasons.push({
      code: "conflicts",
      message: "Resolve merge conflicts.",
      source: "github_pr_state",
      availability: "available",
      openOnGitHub: false,
    });

  reasons.push(...deriveCheckReasons(checks));

  // `has_hooks` and `unstable` are both mergeable states per GitHub's own
  // `MergeStateStatus` semantics, so neither contributes a reason here.
  // Surfacing them as information is a display concern for a later slice.

  // The generic fallback only fires when GitHub reports blocked and nothing
  // above already explained why — including the two named rules above, but
  // also any review/checks reason from another axis, since a maintainer
  // shown a specific reason does not need an additional vague one.
  if (blocked && reasons.length === 0)
    reasons.push({
      code: "blocked",
      message: policyReadable
        ? "GitHub reports this merge is blocked, but none of the readable merge rules explain why."
        : "Patchdesk could not read this repository's merge rules, so it cannot say why GitHub blocked this merge.",
      source: "github_pr_state",
      availability: policyReadable ? "available" : "partial",
      openOnGitHub: true,
    });

  return reasons;
}
