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
 * Permanent Design registry. Review workbench states are a typed unified
 * matrix; no prepared, running, or completed workbench mode is represented.
 */
export const designScenarios: ReadonlyArray<DesignScenario> = [
  // Inbox (4 retained)
  { id: "inbox-default", title: "Inbox default", description: "A populated maintainer inbox with mixed review states.", group: "Inbox" },
  { id: "inbox-empty", title: "Inbox empty", description: "No open pull requests are currently visible.", group: "Inbox" },
  { id: "inbox-loading", title: "Inbox loading", description: "The workspace is still loading its first response.", group: "Inbox" },
  { id: "inbox-error", title: "Inbox error", description: "The workspace request failed and can be retried.", group: "Inbox" },
  { id: "inbox-cached", title: "Inbox cached", description: "The inbox is usable, but GitHub data is stale.", group: "Inbox" },
  { id: "inbox-recovery-states", title: "Inbox recovery states", description: "Every row exposes a one-action recovery chip and reassurance copy.", group: "Inbox" },

  // Unified Review workbench matrix. Every state uses the production Review projection.
  { id: "review-files-default", title: "Files: default", description: "Fresh Review with the full diff and an empty local draft.", group: "Review workbench" },
  { id: "review-files-finding-selected", title: "Files: Finding selected", description: "A current mapped Finding focuses its exact diff evidence.", group: "Review workbench" },
  { id: "review-files-commit-selected", title: "Files: commit selected", description: "A selected commit renders its immutable patch and statistics.", group: "Review workbench" },
  { id: "review-updates-draft", title: "Files: Updates available", description: "Remote activity blocks GitHub writes while local draft editing remains available.", group: "Review workbench" },
  { id: "review-draft-expanded", title: "Files: expanded draft", description: "The persistent Review draft dock owns local editing below the diff.", group: "Review workbench" },
  { id: "review-needs-attention", title: "Files: Needs attention", description: "Unsafe anchors are visible in the focused local repair queue.", group: "Review workbench" },
  { id: "review-pr-overview", title: "Files: PR Overview", description: "Pull request context and merge readiness are shown in the overlay.", group: "Review workbench" },
  { id: "review-merged", title: "Files: merged", description: "A merged Review remains readable with mutation actions absent.", group: "Review workbench" },
  { id: "review-closed", title: "Files: closed", description: "A closed Review remains readable with mutation actions absent.", group: "Review workbench" },
  { id: "insights-overview", title: "Insights: Overview", description: "The Insights surface introduces Analysis and Walkthrough as peers.", group: "Review workbench" },
  { id: "analysis-running", title: "Analysis: Running first run", description: "A bounded first Analysis run exposes progress without partial results.", group: "Review workbench" },
  { id: "analysis-current", title: "Analysis: Current", description: "The retained Analysis is current for the represented revision.", group: "Review workbench" },
  { id: "analysis-outdated", title: "Analysis: Outdated", description: "Retained evidence remains readable while latest revision actions are offered.", group: "Review workbench" },
  { id: "analysis-failed", title: "Analysis: Failed first run", description: "A first-run failure offers bounded recovery without a partial result.", group: "Review workbench" },
  { id: "analysis-replacement-running", title: "Analysis: Replacement running", description: "A replacement run preserves the retained result while showing progress.", group: "Review workbench" },
  { id: "analysis-replacement-failed", title: "Analysis: Replacement failed", description: "Replacement failure preserves the latest successful Analysis.", group: "Review workbench" },
  { id: "walkthrough-current", title: "Walkthrough: Current", description: "The retained walkthrough keeps its outline, reading progress, and evidence.", group: "Review workbench" },
  { id: "walkthrough-outdated", title: "Walkthrough: Outdated", description: "Outdated walkthrough evidence stays readable without coordinate actions.", group: "Review workbench" },
  { id: "publication-ready", title: "Publication: Ready", description: "The exact local draft is ready for explicit GitHub confirmation.", group: "Review workbench" },
  { id: "publication-publishing", title: "Publication: Publishing", description: "The bounded publication operation keeps its exact payload visible.", group: "Review workbench" },
  { id: "publication-confirmed", title: "Publication: Confirmed", description: "Confirmed publication leaves the Review projection and successor draft readable.", group: "Review workbench" },
  { id: "publication-needs-confirmation", title: "Publication: Needs confirmation", description: "Uncertain publication remains frozen until GitHub reconciliation.", group: "Review workbench" },
  { id: "published-feedback-collapsed", title: "Published feedback: collapsed", description: "Published GitHub feedback sits in a bounded shell region beside the collapsed draft.", group: "Review workbench" },
  { id: "published-feedback-expanded", title: "Published feedback: expanded", description: "Published GitHub feedback and the expanded draft remain non-overlapping.", group: "Review workbench" },

  // Settings and dialogs (3 retained)
  { id: "settings-recovery", title: "Settings (recovery)", description: "Global Settings overlay with General, Workspace, Review, and Data & recovery sections.", group: "Settings and dialogs" },
  { id: "dialog-clear-local-data", title: "Dialog: clear local data", description: "Confirmation copy for the destructive local-data cleanup.", group: "Settings and dialogs" },
  { id: "dialog-submit", title: "Submit review dialog", description: "Exact saved action counts appear before creating a pending review.", group: "Settings and dialogs" },
  { id: "dialog-merge", title: "Merge confirmation", description: "Each merge warning is named beside its acknowledgement.", group: "Settings and dialogs" },

  // Walkthrough (5)
  { id: "walkthrough-generate-dialog", title: "Walkthrough: generate", description: "Model and reasoning selection before read-only generation starts.", group: "Walkthrough" },
  { id: "walkthrough-generating", title: "Walkthrough: generating", description: "Progress copy and read-only assurance while generation runs.", group: "Walkthrough" },
  { id: "walkthrough-ready", title: "Walkthrough: ready", description: "Selected reading layout, Support, read progress, Back to files.", group: "Walkthrough" },
  { id: "walkthrough-failed", title: "Walkthrough: failed", description: "Friendly failure with retry that stays on the same snapshot.", group: "Walkthrough" },
  { id: "walkthrough-stale", title: "Walkthrough: stale", description: "Stored patch changed; show the regenerate path for the current snapshot.", group: "Walkthrough" },
];

/**
 * Returns every registered permanent scenario. Temporary exploration entries
 * are intentionally excluded from the acceptance registry.
 */
export function allDesignScenarios(): ReadonlyArray<DesignScenario> {
  return designScenarios;
}

export function scenarioFromLocation(): DesignScenario | undefined {
  if (typeof window === "undefined") return undefined;
  const id = new URLSearchParams(window.location.search).get("scenario");
  return allDesignScenarios().find((scenario) => scenario.id === id);
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
