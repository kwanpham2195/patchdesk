import * as v from "valibot";

import { definePreference } from "./lib/local-preference";

// Whether the visited pull requests column is collapsed is a per-machine view
// choice, so it is a local preference rather than workspace state.
const collapsedPreference = definePreference({
  key: "patchdesk.visited-pull-requests-collapsed.v1",
  schema: v.boolean(),
  defaultValue: false,
});

export function loadVisitedPullRequestsCollapsed(): boolean {
  return collapsedPreference.load();
}

export function saveVisitedPullRequestsCollapsed(collapsed: boolean): void {
  collapsedPreference.save(undefined, collapsed);
}
