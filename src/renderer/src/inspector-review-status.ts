import type { InboxRow } from "@/renderer-contracts";

/** The four states the inspector leads with, in the order it decides them. */
export type InspectorReviewStatusKind =
  | "merged"
  | "not_reviewed"
  | "current"
  | "updates_available";

export type InspectorReviewStatus = {
  readonly kind: InspectorReviewStatusKind;
  readonly label: string;
  /** The reviewed head, then the current head when the two differ. */
  readonly heads: ReadonlyArray<string>;
  readonly description: string;
};

/**
 * What the inspector says about this row's local Review before anything else.
 * A merged pull request answers first: whatever a saved Review matches, the
 * code is landed and the session opens read-only.
 */
export function inspectorReviewStatus(row: InboxRow): InspectorReviewStatus {
  if (row.remoteState === "merged")
    return {
      kind: "merged",
      label: "Merged",
      heads: [shortSha(row.currentHeadSha)],
      description: "Merged on GitHub. The Review opens read-only.",
    };
  if (row.latestReview === undefined)
    return {
      kind: "not_reviewed",
      label: "Not reviewed",
      heads: [shortSha(row.currentHeadSha)],
      description:
        "Open prepares a local Review session for this head. That can take a few seconds.",
    };
  if (row.latestReview.matchesCurrentHead)
    return {
      kind: "current",
      label: "Current",
      heads: [shortSha(row.latestReview.reviewedHeadSha)],
      description: "Your saved Review matches the current head.",
    };
  return {
    kind: "updates_available",
    label: "Updates available",
    heads: [
      shortSha(row.latestReview.reviewedHeadSha),
      shortSha(row.currentHeadSha),
    ],
    description:
      "The head moved since your Review. Open it, then use Refresh to adopt the new code.",
  };
}

/** Heads are named, never compared by eye, so eight characters is enough. */
function shortSha(value: string): string {
  return value.slice(0, 8);
}
