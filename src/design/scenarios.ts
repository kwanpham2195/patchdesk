export type DesignScenario = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: "Inbox" | "Review workbench" | "Settings and dialogs";
};

export const designScenarios: ReadonlyArray<DesignScenario> = [
  { id: "inbox-default", title: "Inbox default", description: "A populated maintainer inbox with mixed review states.", group: "Inbox" },
  { id: "inbox-empty", title: "Inbox empty", description: "No open pull requests are currently visible.", group: "Inbox" },
  { id: "inbox-loading", title: "Inbox loading", description: "The workspace is still loading its first response.", group: "Inbox" },
  { id: "inbox-error", title: "Inbox error", description: "The workspace request failed and can be retried.", group: "Inbox" },
  { id: "inbox-cached", title: "Inbox cached", description: "The inbox is usable, but GitHub data is stale.", group: "Inbox" },
  { id: "review-prepared", title: "Review prepared", description: "A read-only snapshot is ready to inspect or run.", group: "Review workbench" },
  { id: "review-running", title: "Review running", description: "A local review run is active and reporting progress.", group: "Review workbench" },
  { id: "review-completed", title: "Review completed", description: "Findings, checks, comments, and merge readiness are visible.", group: "Review workbench" },
  { id: "settings-default", title: "Settings", description: "Profile, appearance, watchlist, environment, and storage controls.", group: "Settings and dialogs" },
  { id: "dialog-submit", title: "Submit review dialog", description: "A review draft is ready for GitHub submission.", group: "Settings and dialogs" },
  { id: "dialog-merge", title: "Merge confirmation", description: "A merge action with warnings requires acknowledgement.", group: "Settings and dialogs" },
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
