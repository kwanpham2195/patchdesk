import type { MergeDisplayReason } from "../../../domain/github-context";

/** One entry of PR overview's Merge readiness list. */
export type MergeReadinessItem =
  | { readonly kind: "reason"; readonly reason: MergeDisplayReason }
  | { readonly kind: "blocker"; readonly blocker: string };

/**
 * The blocking entries PR overview lists, top to bottom; the Review header's
 * Merge chip names the first one, so both read from this single ordering.
 */
export function mergeReadinessItems(
  blockers: readonly string[],
  mergeReasons: ReadonlyArray<MergeDisplayReason>,
): ReadonlyArray<MergeReadinessItem> {
  // GitHub's display reasons are the more specific evidence, so they replace the raw blocker codes whenever any exist.
  return mergeReasons.length > 0
    ? mergeReasons.map((reason) => ({ kind: "reason", reason }))
    : blockers.map((blocker) => ({ kind: "blocker", blocker }));
}

/** The short name of the first listed blocker, or undefined when it names no specific cause. */
export function firstMergeBlockerLabel(
  blockers: readonly string[],
  mergeReasons: ReadonlyArray<MergeDisplayReason>,
): string | undefined {
  const first = mergeReadinessItems(blockers, mergeReasons)[0];
  if (first === undefined) return undefined;
  return first.kind === "reason"
    ? reasonShortLabel(first.reason.code)
    : blockerShortLabel(first.blocker);
}

function reasonShortLabel(
  code: MergeDisplayReason["code"],
): string | undefined {
  switch (code) {
    case "review_required":
      return "Review";
    case "changes_requested":
      return "Changes requested";
    case "behind":
      return "Behind base";
    case "conflicts":
      return "Conflicts";
    case "checks":
      return "Checks";
    case "blocked":
      return undefined;
  }
}

function blockerShortLabel(blocker: string): string | undefined {
  switch (blocker) {
    case "stale_head":
      return "Outdated";
    case "closed":
      return "Closed";
    case "draft":
      return "Draft";
    case "conflicting":
      return "Conflicts";
    case "required_check":
    case "failing_check":
      return "Checks";
    case "github_review":
      return "Review";
    case "analysis_finding":
      return "Findings";
    default:
      return undefined;
  }
}
