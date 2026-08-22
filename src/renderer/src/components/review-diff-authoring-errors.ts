import { PatchdeskApiError } from "../api-client";

/** Bounded copy for a failed inline write; shared by the composer and pending-write cards. */
export function composerErrorMessage(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (cause.kind === "stale_head")
      return "This pull request has changed. Refresh and try again.";
    if (cause.kind === "github_rejected" || cause.kind === "rejected")
      return "GitHub rejected this comment.";
    if (cause.kind === "revision_conflict")
      return "This comment cannot be published against the current diff.";
    if (cause.kind === "outcome_unknown")
      return "GitHub could not confirm this write. Check GitHub again before trying again.";
    if (
      cause.kind === "no_pending_review" ||
      cause.kind === "pending_review_locked"
    )
      return "The pending review changed. Refresh to see its current state.";
    if (cause.kind === "forbidden")
      return "GitHub blocked this comment: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.";
    return `Patchdesk could not publish this comment (${cause.kind}). Try refreshing.`;
  }
  return cause instanceof Error
    ? cause.message
    : "Patchdesk could not publish this comment.";
}
