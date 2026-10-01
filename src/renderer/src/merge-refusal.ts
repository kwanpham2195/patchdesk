import type { MergeMethod } from "../../domain/github-context";
import { isApiErrorCode } from "./api-client";

/**
 * The copy for a merge that Patchdesk or GitHub refused before anything
 * merged, so no GitHub status check is needed (#691, #756). Undefined for
 * every other failure, including one whose outcome is unknown.
 */
export function mergeRefusalMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a `catch` binding is `unknown` by construction; recognising a PatchdeskApiError is what this function is for.
  cause: unknown,
  method: MergeMethod,
): string | undefined {
  if (isApiErrorCode(cause, "merge_method_not_allowed"))
    return `This repository does not allow ${method} merges. Nothing was merged. Refresh, then choose a method the repository allows.`;
  if (isApiErrorCode(cause, "merge_head_changed"))
    return "GitHub refused the merge because the head branch changed. Nothing was merged. Refresh, then merge again.";
  if (isApiErrorCode(cause, "merge_not_mergeable"))
    return "GitHub refused to merge this pull request. Nothing was merged. Its branch rules or merge settings do not allow the merge right now.";
  if (
    isApiErrorCode(cause, "stale") ||
    isApiErrorCode(cause, "stale_head") ||
    isApiErrorCode(cause, "not_fresh")
  )
    return "Refresh before merging. This Review no longer matches the pull request on GitHub, so Patchdesk did not send the merge. Nothing was merged.";
  if (isApiErrorCode(cause, "merge_blocked"))
    return "GitHub's merge rules block this pull request, so Patchdesk did not send the merge. Nothing was merged. Refresh to see the blocking reason, then resolve it.";
  if (isApiErrorCode(cause, "merge_acknowledgement_required"))
    return "This merge needs your acknowledgement of the warnings listed above, so Patchdesk did not send it. Nothing was merged. Tick the acknowledgement, then merge again.";
  return undefined;
}
