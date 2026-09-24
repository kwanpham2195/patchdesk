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
  // A stale, closed, or draft pull request cannot merge whatever GitHub's rules say, so those lead.
  const leading = blockers.filter((blocker) => leadingBlockers.has(blocker));
  const reasonCodes = new Set(mergeReasons.map((reason) => reason.code));
  const remaining = blockers.filter(
    (blocker) =>
      !leadingBlockers.has(blocker) &&
      !blockerRestatesReason(blocker, reasonCodes),
  );
  return [
    ...leading.map((blocker) => ({ kind: "blocker" as const, blocker })),
    ...mergeReasons.map((reason) => ({ kind: "reason" as const, reason })),
    ...remaining.map((blocker) => ({ kind: "blocker" as const, blocker })),
  ];
}

const leadingBlockers: ReadonlySet<string> = new Set([
  "stale_head",
  "closed",
  "draft",
]);

function blockerRestatesReason(
  blocker: string,
  reasonCodes: ReadonlySet<MergeDisplayReason["code"]>,
): boolean {
  switch (blocker) {
    case "conflicting":
      return reasonCodes.has("conflicts");
    case "required_check":
    case "failing_check":
      return reasonCodes.has("checks");
    case "github_review":
      return (
        reasonCodes.has("review_required") ||
        reasonCodes.has("changes_requested")
      );
    // Any GitHub reason is the specific explanation of GitHub's generic block.
    case "merge_blocked":
      return reasonCodes.size > 0;
    default:
      return false;
  }
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
