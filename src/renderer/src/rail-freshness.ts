import type { WorkbenchResponse } from "./renderer-contracts";

/** `WorkbenchResponse["revision"]["freshness"]`, named here since every
 * `PullRequestMetadataRail` section reads it to render its own freshness
 * line. */
export type RevisionFreshness = WorkbenchResponse["revision"]["freshness"];

/**
 * The muted freshness line every rail section renders under its heading,
 * derived from `model.revision.freshness` — the same signal the workbench
 * header's "Updates available" pill already reads, so the rail never
 * disagrees with the rest of the workbench about how current its data is.
 * A pure function in its own module so every section (Labels today,
 * Assignees and Reviewers later) reuses it verbatim instead of re-deriving
 * its own copy.
 */
export function freshnessCopy(freshness: RevisionFreshness): string {
  switch (freshness) {
    case "fresh":
      return "as of your last refresh";
    case "updates_available":
      return "may be out of date — updates available";
    case "unavailable":
      return "last known state — GitHub could not be reached";
    case "not_refreshed":
      return "not refreshed yet";
  }
}
