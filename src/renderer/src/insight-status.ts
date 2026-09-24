import type { WorkbenchResponse } from "./renderer-contracts";

export type InsightStatus = WorkbenchResponse["insights"]["analysis"]["status"];

/** A current result carries no word: only the other states tell the reviewer to act. */
export const INSIGHT_STATUS_LABELS = {
  not_generated: "Not run",
  running: "Running",
  current: undefined,
  outdated: "Outdated",
  failed: "Failed",
} as const satisfies Record<InsightStatus, string | undefined>;
