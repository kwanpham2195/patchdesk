import * as v from "valibot";
import {
  parseAnalysisInvocationOutcome,
  type AnalysisInvocationOutcome,
} from "./analysis-invocation-outcome";
import type { Result } from "./result";
import type { InsightFailureCategory } from "./insight-record";
import { CODEX_EXPLANATION_VERSION_MESSAGE } from "./codex-explanation-version";

/** Fixed explanation labels may cross storage and UI boundaries without native prose. */
export const EXPLANATION_FAILURE_DETAILS = {
  unsupported_codex_version: CODEX_EXPLANATION_VERSION_MESSAGE,
  provider_completed_without_finish:
    "The model ended before finishing this Guide or Walkthrough. The previous result, if any, is kept.",
} as const;
export type ExplanationFailureDiagnostic =
  keyof typeof EXPLANATION_FAILURE_DETAILS;

/** Safe diagnostic fields; provider text is never copied into them. */
export type InsightFailureDiagnostic = {
  readonly incompleteReason?: "insufficient_evidence" | "unable_to_complete";
  readonly phase?: string;
  readonly code?: string;
  readonly detail?: string;
};

/** Projects only stable application labels, never raw payloads, paths, or provider prose. */
export function insightFailureDiagnostic(
  reason: InsightFailureCategory | "cancelled",
  phase = "turn",
  detail?: string,
): Required<Omit<InsightFailureDiagnostic, "incompleteReason">> {
  if (
    reason === "runtime_unavailable" &&
    phase === "native_policy_unsupported" &&
    detail === "unsupported_codex_version"
  )
    return {
      phase,
      code: "unsupported_codex_version",
      detail: CODEX_EXPLANATION_VERSION_MESSAGE,
    };
  const safePhase = /^[a-z_]{1,40}$/.test(phase) ? phase : "turn";
  return {
    phase: safePhase,
    code: `${safePhase}_${reason}`,
    detail: retainedInsightFailureDetail(detail) ?? FAILURE_DETAILS[reason],
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
  guide_patch_empty: "The represented patch has no changes Guide can index.",
  guide_artifact_unreadable:
    "Guide could not read the represented Review evidence.",
  guide_input_too_large:
    "The represented Review input exceeds Guide's supported size.",
} as const satisfies Record<InsightFailureCategory | "cancelled", string>;

const INCOMPLETE_DETAILS = {
  uninspected:
    "The provider reports that it did not inspect the complete captured change.",
  unavailable: "The provider reports that required evidence was unavailable.",
  denied: "The provider reports that a required evidence read was denied.",
  insufficient_evidence:
    "The provider reports insufficient evidence for a complete Analysis.",
  unable_to_complete:
    "The provider reports that it could not complete the Analysis.",
} as const;
const ORIGINAL_RESPONSE_DETAIL =
  "The provider returned a response before cleanup failed.";
const ORIGINAL_UNKNOWN_DETAIL =
  "The original invocation outcome is unavailable.";
const SAFE_DETAILS = new Set<string>([
  ...Object.values(FAILURE_DETAILS),
  ...Object.values(INCOMPLETE_DETAILS),
  ORIGINAL_RESPONSE_DETAIL,
  ORIGINAL_UNKNOWN_DETAIL,
]);

/** Retain the explanation's meaning through fixed labels, never excerpts or heuristic redaction. */
export function analysisIncompleteDiagnostic(
  incomplete: Extract<
    AnalysisInvocationOutcome,
    { outcome: "incomplete" }
  >["incomplete"],
): Required<InsightFailureDiagnostic> {
  const text = incomplete.detail.toLowerCase().replace(/\s+/gu, " ");
  const detail =
    /\b(?:permission denied|read denied|access denied|not permitted to (?:read|access|inspect))\b/u.test(
      text,
    )
      ? INCOMPLETE_DETAILS.denied
      : /\b(?:evidence|pages?|files?|artifacts?) (?:is |are |was |were )?(?:unavailable|missing|not available)\b|\b(?:cannot|could not) access\b/u.test(
            text,
          )
        ? INCOMPLETE_DETAILS.unavailable
        : /\b(?:cannot|could not|unable to|did not|have not|not able to)\b[^.]*\b(?:inspect|review|read)\b[^.]*\b(?:complete|full|entire)\b|\b(?:cannot|could not|unable to)\b[^.]*\b(?:complete|full|entire)\b[^.]*\b(?:inspect|review|read)\b/u.test(
              text,
            )
          ? INCOMPLETE_DETAILS.uninspected
          : INCOMPLETE_DETAILS[incomplete.reason];
  return {
    ...insightFailureDiagnostic("analysis_incomplete", incomplete.reason),
    detail,
    incompleteReason: incomplete.reason,
  };
}

/** Cleanup keeps only the approved earlier summary; no result payload or thrown cause survives. */
export function insightCleanupFailureDetail(
  cleanup: "process" | "home",
  original?: string,
): string {
  const detail =
    original === undefined
      ? ORIGINAL_UNKNOWN_DETAIL
      : original === "response_received"
        ? ORIGINAL_RESPONSE_DETAIL
        : SAFE_DETAILS.has(original)
          ? original
          : ORIGINAL_UNKNOWN_DETAIL;
  return `${cleanup === "process" ? "Process" : "Private home"} cleanup failed. ${detail}`;
}

/** Native cleanup retains only a safe summary of the preceding response or classified failure. */
export function insightOriginalInvocationDetail(
  result:
    | Result<
        unknown,
        InsightFailureDiagnostic & {
          readonly reason: InsightFailureCategory | "cancelled";
        }
      >
    | undefined,
): string | undefined {
  if (result === undefined) return undefined;
  if (result._tag === "err")
    return (
      retainedInsightFailureDetail(result.error.detail) ??
      insightFailureDiagnostic(result.error.reason).detail
    );
  const outcome = parseAnalysisInvocationOutcome(result.value);
  return outcome._tag === "ok" && outcome.value.outcome === "incomplete"
    ? analysisIncompleteDiagnostic(outcome.value.incomplete).detail
    : "response_received";
}

/** A caller cannot promote arbitrary provider detail into the log-safe vocabulary. */
function retainedInsightFailureDetail(
  detail: string | undefined,
): string | undefined {
  if (detail === undefined) return undefined;
  if (SAFE_DETAILS.has(detail)) return detail;
  for (const prefix of [
    "Process cleanup failed. ",
    "Private home cleanup failed. ",
  ]) {
    if (
      detail.startsWith(prefix) &&
      SAFE_DETAILS.has(detail.slice(prefix.length))
    )
      return detail;
  }
  return undefined;
}

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
  const retained = retainedInsightFailureDetail(message);
  if (retained !== undefined) return retained;
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
