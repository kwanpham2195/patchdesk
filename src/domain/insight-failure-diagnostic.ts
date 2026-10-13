import * as v from "valibot";
import type { InsightFailureCategory } from "./insight-record";

/** Safe diagnostic fields; provider text is never copied into them. */
export type InsightFailureDiagnostic = {
  readonly phase?: string;
  readonly code?: string;
  readonly detail?: string;
};

/** Projects only stable application labels, never raw payloads, paths, or provider prose. */
export function insightFailureDiagnostic(
  reason: InsightFailureCategory | "cancelled",
  phase = "turn",
): Required<InsightFailureDiagnostic> {
  const safePhase = /^[a-z_]{1,40}$/.test(phase) ? phase : "turn";
  return {
    phase: safePhase,
    code: `${safePhase}_${reason}`,
    detail: FAILURE_DETAILS[reason],
  };
}

const FAILURE_DETAILS = {
  cancelled: "The run was cancelled.",
  authentication_required: "The provider requires authentication.",
  rate_limited: "The provider rate limit was reached.",
  runtime_unavailable:
    "The selected runtime or required capability is unavailable.",
  review_worktree_unavailable: "The represented Review files are unavailable.",
  timed_out: "The provider run timed out.",
  execution_failed: "The provider refused or failed the run.",
  invalid_result: "The provider returned an invalid result.",
  unexpected_failure: "The run failed unexpectedly.",
  evidence_unavailable: "Captured evidence is unavailable.",
  evidence_mismatch: "Captured evidence does not match this run.",
  analysis_incomplete: "The provider could not complete the Analysis.",
} as const satisfies Record<InsightFailureCategory | "cancelled", string>;

/** Unknown echoed material is replaced wholesale rather than heuristically redacted. */
export function sanitizedInsightFailureDetail(cause: unknown): string {
  let current = cause;
  let message = "";
  for (let depth = 0; depth < 5; depth += 1) {
    const text = v.safeParse(v.string(), current);
    if (text.success) {
      message = text.output;
      break;
    }
    if (!(current instanceof Error)) break;
    message = current.message;
    current = current.cause;
  }
  const text = message.toLowerCase();
  const detail = text.includes("insufficient balance")
    ? "Insufficient Balance"
    : text.includes("overloaded")
      ? "The provider is overloaded."
      : text.includes("rate limit")
        ? "The provider rate limit was reached."
        : "The provider refused or failed the run.";
  return text.includes("retried 3 times without success")
    ? `Retried 3 times without success: ${detail}`
    : detail;
}

/** A malformed captured descriptor is a mismatch, not a provider failure. */
export function insightEvidenceFailureCategory(
  reason: "evidence_unavailable" | "evidence_mismatch" | "invalid_input",
): "evidence_unavailable" | "evidence_mismatch" {
  return reason === "evidence_unavailable" ? reason : "evidence_mismatch";
}
