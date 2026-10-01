import type { PendingReviewOperation } from "./pending-review";
import type { ReviewWriteIntentTag } from "./review-write-operation";

/**
 * Why GitHub refused a write: the resource is missing, conflicts with its
 * current state, does not allow the request, failed validation, or the
 * endpoint is not implemented.
 */
export const REFUSAL_CAUSES = [
  "not_found",
  "conflict",
  "not_allowed",
  "unprocessable",
  "unsupported",
] as const;

export type RefusalCause = (typeof REFUSAL_CAUSES)[number];

/** Every GitHub write the application issues, keyed once for the refusal table. */
export type WriteKind =
  | ReviewWriteIntentTag
  | `PendingReview${PendingReviewOperation["_tag"]}`
  | "DirectSummaryReview"
  | "Merge";

/**
 * `final`: a landed first delivery cannot produce this refusal, so the write
 * did not happen. `landed_check`: a resent write whose first delivery landed
 * can get the same refusal, so it is final only after a read shows the state
 * the write would change is unchanged (ADR 0046, issue #755).
 */
type RefusalFinality = "final" | "landed_check";

const FINALITY = {
  CreateComment: "final",
  Reply: "final",
  EditComment: "final",
  EditPublishedComment: "final",
  DirectSummaryReview: "final",
  PendingReviewStart: "final",
  PendingReviewAddThread: "final",
  SetThreadState: "landed_check",
  DeleteComment: "landed_check",
  DeletePublishedComment: "landed_check",
  DismissPublishedReview: "landed_check",
  PendingReviewSubmit: "landed_check",
  PendingReviewDiscard: "landed_check",
  AddLabels: "landed_check",
  RemoveLabels: "landed_check",
  AddAssignees: "landed_check",
  RemoveAssignees: "landed_check",
  RequestReviewers: "landed_check",
  RemoveReviewers: "landed_check",
  SetDraftState: "landed_check",
  SetBaseBranch: "landed_check",
  Merge: "landed_check",
} as const satisfies Record<WriteKind, RefusalFinality>;

/** Every write kind in the table; the table test iterates it. */
export const WRITE_KINDS: ReadonlyArray<WriteKind> =
  // SAFETY: `FINALITY` satisfies `Record<WriteKind, ...>`, so its keys are exactly the WriteKind values.
  Object.keys(FINALITY) as ReadonlyArray<WriteKind>;

/** Whether a refusal of this `cause` is final for `kind` with no read. An unimplemented endpoint (`unsupported`) is final for every kind. */
export function refusalFinality(
  kind: WriteKind,
  cause: RefusalCause,
): RefusalFinality {
  return cause === "unsupported" ? "final" : FINALITY[kind];
}
