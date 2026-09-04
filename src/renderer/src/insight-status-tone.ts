import type { WorkbenchResponse } from "./renderer-contracts";

type InsightStatus = WorkbenchResponse["insights"]["analysis"]["status"];

/** The Badge tone that tells a reviewer, at a glance, whether an Insight is usable. */
export type InsightStatusTone =
  | "success"
  | "warning"
  | "secondary"
  | "destructive"
  | "outline";

/**
 * Current is the only state whose document navigates the live code, so it
 * alone reads as success. Outdated evidence is still readable, so amber
 * rather than red; Running is neutral with a spinner; Not generated is the
 * quiet outline of an option not yet taken.
 */
export function insightStatusTone(status: InsightStatus): InsightStatusTone {
  switch (status) {
    case "current":
      return "success";
    case "outdated":
      return "warning";
    case "running":
      return "secondary";
    case "failed":
      return "destructive";
    case "not_generated":
      return "outline";
  }
}
