import type { MergeMethod } from "../../domain/github-context";
import type { RefusalCause } from "../../domain/github-write-refusal";
import { isApiErrorCode } from "./api-client";
import { refusalCausePhrase } from "./write-refusal-copy";

/** The cause and the next step for each stored merge reason GitHub's refusal produces. */
const mergeRefusals: ReadonlyArray<{
  readonly reason: string;
  readonly cause: RefusalCause;
  readonly nextStep: string;
}> = [
  {
    reason: "merge_head_changed",
    cause: "conflict",
    nextStep: "Refresh, then merge again.",
  },
  {
    reason: "merge_not_mergeable",
    cause: "not_allowed",
    nextStep: "Check its branch rules and merge settings, then try again.",
  },
  {
    reason: "not_found",
    cause: "not_found",
    nextStep: "Refresh the Review, then try again.",
  },
];

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
  for (const refusal of mergeRefusals)
    if (isApiErrorCode(cause, refusal.reason))
      return `${refusalCausePhrase(refusal.cause, "merge")} Nothing was merged. ${refusal.nextStep}`;
  if (isApiErrorCode(cause, "merge_unsupported"))
    return "GitHub does not offer merging this pull request through its API. Nothing was merged. Merge it on GitHub instead.";
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
