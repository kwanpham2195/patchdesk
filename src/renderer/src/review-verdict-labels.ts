import type { ReviewVerdictState } from "../../domain/review-verdicts";

/** One word per verdict, shared by the Reviewers rail and the Conversation review cards. */
export const REVIEW_VERDICT_LABELS = {
  approved: "Approved",
  changes_requested: "Changes requested",
  commented: "Commented",
  dismissed: "Dismissed",
} as const satisfies Record<ReviewVerdictState, string>;
