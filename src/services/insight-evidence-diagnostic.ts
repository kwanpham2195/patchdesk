import type { InsightEvidenceFailureDetail } from "#src/domain/insight-evidence";
import type { LogEntryInput } from "#src/domain/log-entry";

/** Uses the process log owner; diagnostic delivery cannot change evidence outcomes. */
export function logInsightEvidenceFailure(
  sink: ((entry: LogEntryInput) => void) | undefined,
  runId: string,
  detail: InsightEvidenceFailureDetail,
): void {
  try {
    sink?.({
      process: "main",
      level: "warn",
      topic: "insight-evidence",
      message: "Captured evidence validation failed",
      correlationId: runId,
      meta: { reason: detail },
    });
  } catch {
    // The observed evidence failure remains authoritative when logging fails.
  }
}
