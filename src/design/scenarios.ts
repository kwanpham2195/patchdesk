export type DesignScenarioGroup =
  | "Inbox"
  | "Review workbench"
  | "Settings and dialogs"
  | "Walkthrough";

export type DesignScenario = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: DesignScenarioGroup;
};

/**
 * Permanent Design registry. The four-paragraph plan explicitly lists 22
 * scenarios: 10 retained existing inbox/workbench/settings entries, seven
 * recovery/Settings entries, and five walkthrough entries.
 */
export const designScenarios: ReadonlyArray<DesignScenario> = [
  // Inbox (4 retained)
  { id: "inbox-default", title: "Inbox default", description: "A populated maintainer inbox with mixed review states.", group: "Inbox" },
  { id: "inbox-empty", title: "Inbox empty", description: "No open pull requests are currently visible.", group: "Inbox" },
  { id: "inbox-loading", title: "Inbox loading", description: "The workspace is still loading its first response.", group: "Inbox" },
  { id: "inbox-error", title: "Inbox error", description: "The workspace request failed and can be retried.", group: "Inbox" },
  { id: "inbox-cached", title: "Inbox cached", description: "The inbox is usable, but GitHub data is stale.", group: "Inbox" },
  { id: "inbox-recovery-states", title: "Inbox recovery states", description: "Every row exposes a one-action recovery chip and reassurance copy.", group: "Inbox" },

  // Review workbench (3 retained)
  { id: "review-prepared", title: "Review prepared", description: "A read-only snapshot is ready to inspect or run.", group: "Review workbench" },
  { id: "review-running", title: "Review running", description: "A local review run is active and reporting progress.", group: "Review workbench" },
  { id: "review-completed", title: "Review completed", description: "Findings, checks, comments, and merge readiness are visible.", group: "Review workbench" },
  { id: "workbench-reconnect", title: "Workbench: reconnect", description: "Owned live run — show Reconnect as the only next action.", group: "Review workbench" },
  { id: "workbench-start-again", title: "Workbench: start again", description: "Unowned or interrupted run — show Start again, no background guess.", group: "Review workbench" },
  { id: "workbench-try-again", title: "Workbench: try again", description: "Failed attempt — show Try again with one reassurance.", group: "Review workbench" },
  { id: "workbench-prepare-again", title: "Workbench: prepare again", description: "Invalid preparation — show Prepare again in destructive tone.", group: "Review workbench" },

  // Settings and dialogs (3 retained)
  { id: "settings-recovery", title: "Settings (recovery)", description: "Global Settings overlay with General, Review, and Data & recovery sections.", group: "Settings and dialogs" },
  { id: "dialog-clear-local-data", title: "Dialog: clear local data", description: "Confirmation copy for the destructive local-data cleanup.", group: "Settings and dialogs" },
  { id: "dialog-submit", title: "Submit review dialog", description: "A review draft is ready for GitHub submission.", group: "Settings and dialogs" },
  { id: "dialog-merge", title: "Merge confirmation", description: "A merge action with warnings requires acknowledgement.", group: "Settings and dialogs" },

  // Walkthrough (5)
  { id: "walkthrough-generate-dialog", title: "Walkthrough: generate", description: "Model and reasoning selection before read-only generation starts.", group: "Walkthrough" },
  { id: "walkthrough-generating", title: "Walkthrough: generating", description: "Progress copy and read-only assurance while generation runs.", group: "Walkthrough" },
  { id: "walkthrough-ready", title: "Walkthrough: ready", description: "Selected reading layout, Support, Reviewed controls, Back to files.", group: "Walkthrough" },
  { id: "walkthrough-failed", title: "Walkthrough: failed", description: "Friendly failure with retry that stays on the same snapshot.", group: "Walkthrough" },
  { id: "walkthrough-stale", title: "Walkthrough: stale", description: "Stored patch changed; show the regenerate path for the current snapshot.", group: "Walkthrough" },
];

export function scenarioFromLocation(): DesignScenario | undefined {
  if (typeof window === "undefined") return undefined;
  const id = new URLSearchParams(window.location.search).get("scenario");
  return designScenarios.find((scenario) => scenario.id === id);
}

export function scenarioUrl(id: string): string {
  return `?scenario=${encodeURIComponent(id)}`;
}

export function fixtureHashForScenario(id: string | undefined): string | undefined {
  switch (id) {
    case "dialog-submit":
      return "#submission-fixture";
    case "dialog-merge":
      return "#merge-fixture";
    default:
      return undefined;
  }
}
