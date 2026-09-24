import { isAnalysisFindingHandled } from "../../domain/analysis-merge-findings";
import type { WorkbenchResponse } from "./renderer-contracts";

export type AnalysisResult = NonNullable<
  WorkbenchResponse["insights"]["analysis"]["retained"]
>["value"];
export type AnalysisFindingStatus =
  | "actionable"
  | "pending_review"
  | "published"
  | "locked";
export type CheckStatus = WorkbenchResponse["checks"]["overall"];

/**
 * The findings still waiting on the maintainer. Same handled rule as merge
 * readiness, so the banner and the readiness card never disagree on
 * how many findings are open.
 */
export function unhandledAnalysisFindings(
  result: AnalysisResult,
  findingStatuses: Readonly<Record<string, AnalysisFindingStatus>> | undefined,
): ReadonlyArray<AnalysisResult["findings"][number]> {
  return result.findings.filter((finding) => {
    const status = findingStatuses?.[finding.id];
    return !isAnalysisFindingHandled({
      disposition: finding.disposition === "dismissed" ? "dismissed" : "open",
      // The contract's "added" disposition names the same state as a receipt.
      addedToReview:
        finding.disposition === "added" ||
        status === "pending_review" ||
        status === "published",
    });
  });
}

/** The verdict chip's text. */
export function analysisVerdictLabel(
  verdict: AnalysisResult["verdict"],
): string {
  switch (verdict) {
    case "approve":
      return "Ready to approve";
    case "request_changes":
      return "Changes requested";
    case "comment":
      return "Comment recommended";
  }
}

export function checkStatusLabel(status: CheckStatus): string {
  switch (status) {
    case "passing":
      return "Passing";
    case "failing":
      return "Failing";
    case "pending":
      return "Pending";
    case "skipped":
      return "Skipped";
    case "none":
      return "No checks";
    case "unknown":
      return "Unknown";
  }
}

/** A Finding's `file:line` label, or undefined when it has no file. */
export function findingLocation(
  finding: AnalysisResult["findings"][number],
): string | undefined {
  return finding.file === undefined
    ? undefined
    : `${finding.file}${finding.lineStart === undefined ? "" : `:${finding.lineStart}`}`;
}
