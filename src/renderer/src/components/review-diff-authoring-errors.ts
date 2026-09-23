import { PatchdeskApiError } from "../api-client";
import { forbiddenWriteCopy, unconfirmedWriteCopy } from "../review-copy";

/** Bounded copy for a failed inline write; shared by the composer and pending-write cards. */
export function composerErrorMessage(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (cause.kind === "stale_head")
      return "This pull request has changed. Refresh and try again.";
    if (cause.kind === "github_rejected")
      return "This comment was refused. Refresh to see the current state, then try again.";
    if (cause.kind === "pending_review")
      return "GitHub already holds an unfinished review on this pull request. Refresh, then add this comment to that review.";
    if (cause.kind === "revision_conflict")
      return "This comment cannot be published against the current diff.";
    if (cause.kind === "outcome_unknown") return unconfirmedWriteCopy("write");
    if (
      cause.kind === "no_pending_review" ||
      cause.kind === "pending_review_locked"
    )
      return "The pending review changed. Refresh to see its current state.";
    if (cause.kind === "forbidden") return forbiddenWriteCopy("comment");
    return `Patchdesk could not publish this comment (${cause.kind}). Try refreshing.`;
  }
  return cause instanceof Error
    ? cause.message
    : "Patchdesk could not publish this comment.";
}
