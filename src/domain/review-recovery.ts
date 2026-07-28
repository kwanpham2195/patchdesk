import type { ReviewAttemptState } from "./review-attempt";
import type { ReviewSessionState } from "./review-session";

export type ReviewRecoveryAction =
  | "run_review"
  | "reconnect"
  | "start_again"
  | "try_again"
  | "prepare_again";

export type ReviewRecoveryNoticeKey =
  | "preparing"
  | "ready_to_review"
  | "review_in_progress"
  | "review_interrupted"
  | "review_failed"
  | "needs_preparation";

export type ReviewRecoveryTone = "neutral" | "positive" | "warning" | "destructive";

export type ReviewRecoveryView = {
  readonly noticeKey: ReviewRecoveryNoticeKey;
  readonly tone: ReviewRecoveryTone;
  readonly actionKey?: ReviewRecoveryAction;
};

export type ReviewRecoveryDecision =
  | { readonly _tag: "Preparing" }
  | { readonly _tag: "Actionable"; readonly action: ReviewRecoveryAction }
  | { readonly _tag: "Unavailable" };

/** Inputs required to choose one safe maintainer-facing recovery action. */
export type ReviewRecoveryInput = {
  readonly session: { readonly state: { readonly _tag: ReviewSessionState["_tag"] } };
  readonly latestAttempt?: { readonly state: { readonly _tag: ReviewAttemptState["_tag"] } };
  /** True when a durable preparation operation is active for this session. */
  readonly activePreparation?: boolean;
  /** True only when this process owns the live run for this session. */
  readonly liveRun?: boolean;
};

/**
 * Choose one display-safe recovery action from durable state and process-owned
 * capabilities. This function never emits copy, identifiers, paths, or errors.
 */
export function decideReviewRecovery(
  input: ReviewRecoveryInput,
): ReviewRecoveryDecision {
  if (input.activePreparation === true) return { _tag: "Preparing" };
  if (input.session.state._tag === "Merged") return { _tag: "Unavailable" };

  const attemptState = input.latestAttempt?.state;
  if (attemptState?._tag === "Failed" || input.session.state._tag === "ReviewFailed") {
    return { _tag: "Actionable", action: "try_again" };
  }
  if (attemptState?._tag === "Interrupted") {
    return { _tag: "Actionable", action: "start_again" };
  }

  switch (input.session.state._tag) {
    case "Created":
    case "Discarded":
    case "ReviewCompleted":
      return { _tag: "Actionable", action: "run_review" };
    case "Running":
      return {
        _tag: "Actionable",
        action: input.liveRun === true ? "reconnect" : "start_again",
      };
    case "Stale":
      return { _tag: "Actionable", action: "prepare_again" };
    default:
      return { _tag: "Unavailable" };
  }
}

/** Project one recovery decision into the renderer-safe stable-key view. */
export function projectReviewRecovery(
  decision: ReviewRecoveryDecision,
): ReviewRecoveryView | undefined {
  if (decision._tag === "Unavailable") return undefined;
  if (decision._tag === "Preparing") {
    return { noticeKey: "preparing", tone: "neutral" };
  }
  switch (decision.action) {
    case "run_review":
      return { noticeKey: "ready_to_review", tone: "positive", actionKey: decision.action };
    case "reconnect":
      return { noticeKey: "review_in_progress", tone: "positive", actionKey: decision.action };
    case "start_again":
      return { noticeKey: "review_interrupted", tone: "warning", actionKey: decision.action };
    case "try_again":
      return { noticeKey: "review_failed", tone: "warning", actionKey: decision.action };
    case "prepare_again":
      return { noticeKey: "needs_preparation", tone: "warning", actionKey: decision.action };
  }
}
