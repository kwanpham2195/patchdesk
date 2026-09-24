import type { WorkbenchResponse } from "./renderer-contracts";

/** `WorkbenchResponse["revision"]["freshness"]`, named here since every
 * `PullRequestMetadataRail` section reads it to render its own freshness
 * line. */
export type RevisionFreshness = WorkbenchResponse["revision"]["freshness"];

/**
 * The muted line at the top of the metadata rail when its data may be behind,
 * from the same `model.revision.freshness` the workbench header reads, so the
 * two never disagree. A fresh Review gets none.
 */
export function freshnessCopy(
  freshness: RevisionFreshness,
): string | undefined {
  switch (freshness) {
    case "fresh":
      return undefined;
    case "updates_available":
      return "may be out of date — updates available";
    case "unavailable":
      return "last known state — GitHub could not be reached";
    case "not_refreshed":
      return "not refreshed yet";
  }
}

/** The plain words the workbench meta line and PR overview use for a Review's freshness; the glossary calls the first state Fresh. */
export function revisionFreshnessLabel(freshness: RevisionFreshness): string {
  switch (freshness) {
    case "fresh":
      return "Up to date with GitHub";
    case "updates_available":
      return "Newer revision on GitHub";
    case "unavailable":
      return "Could not reach GitHub";
    case "not_refreshed":
      return "Not checked with GitHub yet";
  }
}
