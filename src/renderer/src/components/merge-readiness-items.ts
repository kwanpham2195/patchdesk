import type { MergeDisplayReason } from "../../../domain/github-context";

/** One entry of PR overview's Merge readiness list. */
export type MergeReadinessItem =
  | { readonly kind: "reason"; readonly reason: MergeDisplayReason }
  | { readonly kind: "blocker"; readonly blocker: string };

/**
 * The blocking entries PR overview lists, top to bottom; the Review header's
 * Merge chip names the first one and counts the rest, so both read from this single ordering.
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

/** The short names of the listed blockers in list order, skipping entries that name no specific cause. */
export function mergeBlockerLabels(
  blockers: readonly string[],
  mergeReasons: ReadonlyArray<MergeDisplayReason>,
): ReadonlyArray<string> {
  const labels = mergeReadinessItems(blockers, mergeReasons).map((item) =>
    item.kind === "reason"
      ? reasonShortLabel(item.reason.code)
      : blockerShortLabel(item.blocker),
  );
  return [...new Set(labels.filter((label) => label !== undefined))];
}

/** What a Blocked Merge chip shows and what assistive tech reads for it. */
type BlockedMergeChip = {
  readonly text: string;
  readonly accessibleName: string;
};

/**
 * The Merge chip for a Blocked Review: it names the first cause and counts
 * the rest, while its accessible name lists every cause.
 */
export function blockedMergeChip(
  labels: ReadonlyArray<string>,
): BlockedMergeChip {
  const [first] = labels;
  if (first === undefined)
    return { text: "Blocked", accessibleName: "blocked" };
  const more = labels.length > 1 ? ` +${labels.length - 1}` : "";
  return {
    text: `Blocked · ${first}${more}`,
    accessibleName: `blocked: ${labels.join(", ").toLowerCase()}`,
  };
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
