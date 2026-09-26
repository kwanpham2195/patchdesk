import {
  renderChangeIntentSection,
  type ResolvedChangeIntent,
} from "./change-intent";

/**
 * What Analysis checks the patch against: a pull request's description
 * (#470), or a local Review's Change intent (#467). `review-input.md` ends
 * with its section; Brief and Walkthrough never read that file.
 */
export type StatedGoal =
  | { readonly kind: "change_intent"; readonly resolved: ResolvedChangeIntent }
  | { readonly kind: "pull_request_description"; readonly markdown: string };

export function renderStatedGoalSection(goal: StatedGoal): string {
  if (goal.kind === "change_intent")
    return renderChangeIntentSection(goal.resolved);
  return [
    "## Pull request description",
    "",
    "BEGIN PULL REQUEST DESCRIPTION",
    goal.markdown.trimEnd(),
    "END PULL REQUEST DESCRIPTION",
    "",
  ].join("\n");
}
