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

/** Each finding's review state, keyed by id, as the Analysis reader consumes it. */
export function analysisFindingStatuses(
  actions: WorkbenchResponse["analysisReviewActions"],
): Readonly<Record<string, AnalysisFindingStatus>> {
  return Object.fromEntries(
    Object.entries(actions?.findings ?? {}).map(([id, status]) => [
      id,
      status.state,
    ]),
  );
}

/**
 * The findings still waiting on the maintainer. Same handled rule as merge
 * readiness, so the banner, the overview card, and the readiness card never
 * disagree on how many findings are open.
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
    case "unknown":
      return "Unknown";
  }
}

/** One line for the overview card: verdict, open finding count, CI state. */
export function analysisHeadline({
  result,
  findingStatuses,
  checkStatus,
}: {
  readonly result: AnalysisResult;
  readonly findingStatuses:
    | Readonly<Record<string, AnalysisFindingStatus>>
    | undefined;
  readonly checkStatus: CheckStatus;
}): string {
  const open = unhandledAnalysisFindings(result, findingStatuses).length;
  const attention =
    open === 0
      ? "none need attention"
      : `${open} ${open === 1 ? "needs" : "need"} attention`;
  return `${analysisVerdictLabel(result.verdict)} · ${attention} · CI ${checkStatusLabel(checkStatus).toLowerCase()}`;
}
