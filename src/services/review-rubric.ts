import { insightOutputGuidance } from "../domain/insight-output-guidance";

/**
 * The severity scale the profile's merge policy keys on: it blocks or asks for
 * acknowledgement on P0 and P1, so an uncalibrated P1 decides a merge.
 */
const SEVERITY_RUBRIC = [
  "Give every finding one severity.",
  "P0 is a defect that loses data, breaks security, or blocks the release.",
  "P1 is a correctness defect a user will hit.",
  "P2 is a defect with a workaround, or a real maintainability risk.",
  "P3 is a nit.",
  "P0 and P1 are the findings that block a merge. P2 and P3 do not block a merge, so never raise a finding to P1 to draw attention to it, and never lower a merge blocker to P2 to avoid the block.",
  "The verdict must match the findings: use request_changes when any finding is P0 or P1, comment when there are findings but none are P0 or P1, and approve only when findings is empty. A mismatch fails the whole run.",
].join(" ");

const FINDING_CONTENT = [
  "Write each finding as symptom, mechanism, expected behavior: affectedScenario is what a user hits, explanation is why the code produces it, and suggestedChange is what the code should do instead.",
  "Give a finding you cannot ground in the patch, the context, or an inspector result no place in findings; record it as an unresolved item.",
].join(" ");

const REPOSITORY_RULES = [
  "The review context document carries this repository's own rule files, such as AGENTS.md and CONTRIBUTING.md, under projectReviewCriteria.",
  "Apply them as review criteria, not as background reading.",
  "Name the rule you applied in the finding's explanation, so a finding that comes from a repository rule is distinguishable from your own taste.",
].join(" ");

const DESCRIPTION_CHECK = [
  "Check the pull request description against the patch, because this Insight is the one that owns that check.",
  "A goal the description states and the patch does not deliver is a finding, and so is a change the patch makes and the description does not mention; give each one severity P2, since it blocks the review rather than the code.",
  "When the description states no goal at all, record an unresolved item instead of a finding.",
  "A decision the author explained in a review thread counts as part of the description.",
].join(" ");

/** Builds the one full represented-revision Analysis prompt both providers send. */
export function composeReviewPrompt(input: {
  readonly reviewInput: string;
  readonly context: string;
  readonly fullPatch: string;
}): string {
  return [
    "Review the complete represented pull request and decide whether it should merge.",
    insightOutputGuidance("analysis"),
    SEVERITY_RUBRIC,
    FINDING_CONTENT,
    REPOSITORY_RULES,
    DESCRIPTION_CHECK,
    "REVIEW INPUT:",
    input.reviewInput,
    "REVIEW CONTEXT DOCUMENT:",
    input.context,
    "PATCH ARTIFACT:",
    input.fullPatch,
  ].join("\n\n");
}
