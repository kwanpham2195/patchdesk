import type { MergeDisplayReason } from "../../../domain/github-context";
import {
  evaluateMergeReadiness,
  type MergeReadiness,
} from "../../../domain/merge-readiness";
import type { InboxRow } from "../renderer-contracts";

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

// A Blocked tag whose only blocker is mergeability_unknown means GitHub has not reported mergeability yet, so it reads neutral (ADR 0027, "Unknown is not failure").
export function isUnconfirmedBlock(
  tag: MergeReadiness["_tag"],
  blockers: readonly string[],
): boolean {
  return (
    tag === "Blocked" &&
    blockers.length === 1 &&
    blockers[0] === "mergeability_unknown"
  );
}

// A draft is the author's choice to hold the merge, not a problem to fix, so a
// block made only of draft and closed states is not given the destructive tone.
function isDraftOnlyBlock(
  tag: MergeReadiness["_tag"],
  blockers: readonly string[],
): boolean {
  return (
    tag === "Blocked" &&
    blockers.includes("draft") &&
    blockers.every((blocker) => blocker === "draft" || blocker === "closed")
  );
}

/** What the Merge readiness header reads for one readiness tag. */
export function mergeReadinessLabel(
  tag: MergeReadiness["_tag"],
  blockers: readonly string[],
): string {
  if (isUnconfirmedBlock(tag, blockers)) return "Unknown";
  if (isDraftOnlyBlock(tag, blockers)) return "Draft";
  switch (tag) {
    case "Ready":
      return "Ready to merge";
    case "NeedsAcknowledgement":
      return "Warnings";
    case "Blocked":
      return "Blocked";
  }
}

/** The semantic tone token the Merge readiness header is rendered in. */
export function mergeReadinessTone(
  tag: MergeReadiness["_tag"],
  blockers: readonly string[],
): string {
  if (isUnconfirmedBlock(tag, blockers)) return infoTone;
  if (isDraftOnlyBlock(tag, blockers)) return mutedTone;
  switch (tag) {
    case "Ready":
      return successTone;
    case "NeedsAcknowledgement":
      return warningTone;
    case "Blocked":
      return destructiveTone;
  }
}

export const successTone = "text-status-success";
export const warningTone = "text-status-warning";
export const destructiveTone = "text-destructive";
export const mutedTone = "text-muted-foreground";
const infoTone = "text-status-info";

/** What the Pull requests inspector's Merge fact reads, in PR overview's readiness wording and tone. */
type InboxRowMergeFact = {
  readonly text: string;
  readonly accessibleName: string;
  readonly tone: string;
};

/**
 * The Merge fact for one listing row. The listing reads GitHub's `mergeable`,
 * draft state, check rollup, and review decision but not branch rules, so a
 * required check still running or a strict "behind base" rule shows only in
 * the Review.
 */
export function inboxRowMergeFact(row: InboxRow): InboxRowMergeFact {
  if (row.remoteState === "merged")
    return { text: "Merged", accessibleName: "merged", tone: successTone };
  const readiness = evaluateMergeReadiness({
    isCurrentHead: true,
    isOpen: true,
    isDraft: row.isDraft,
    mergeability: row.mergeability,
    // The listing reads only the check rollup, never per-check required flags.
    checks: { overall: row.checks.overall, checks: [] },
    hasFailingChecks: row.checks.overall === "failing",
    hasGitHubReviewBlocker: row.reviewState === "review_pending",
    hasRequestChanges: row.reviewState === "changes_requested",
    openHighSeverityFindingIds: [],
  });
  const text = mergeReadinessLabel(readiness._tag, readiness.blockers);
  const tone = mergeReadinessTone(readiness._tag, readiness.blockers);
  const namesCauses =
    readiness._tag === "Blocked" &&
    !isUnconfirmedBlock(readiness._tag, readiness.blockers) &&
    !isDraftOnlyBlock(readiness._tag, readiness.blockers);
  return namesCauses
    ? {
        ...blockedMergeChip(mergeBlockerLabels(readiness.blockers, [])),
        tone,
      }
    : { text, accessibleName: text.toLowerCase(), tone };
}
