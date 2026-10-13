import * as v from "valibot";
import {
  modelReviewResultSchema,
  parseModelReviewResult,
  type ModelReviewResult,
} from "./review-result";
import { err, ok, type Result } from "./result";

/** Explicit unsuccessful Analysis; diagnostic text is never retained as a result. */
export const incompleteAnalysisSchema = v.strictObject({
  reason: v.picklist(["insufficient_evidence", "unable_to_complete"]),
  detail: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(200),
    v.check((value) => value.trim().length > 0),
  ),
});
/** Native object root; cross-field validity is checked after transport decoding. */
export const analysisInvocationOutcomeSchema = v.strictObject({
  outcome: v.picklist(["complete", "incomplete"]),
  result: v.nullable(modelReviewResultSchema),
  incomplete: v.nullable(incompleteAnalysisSchema),
});
/** Transport shape checked before Codex removes optional result nulls. */
export const analysisInvocationEnvelopeSchema = v.strictObject({
  outcome: v.picklist(["complete", "incomplete"]),
  result: v.nullable(v.unknown()),
  incomplete: v.nullable(incompleteAnalysisSchema),
});
/** Parsed terminal outcome, with a validated success result or explicit failure. */
export type AnalysisInvocationOutcome =
  | { readonly outcome: "complete"; readonly result: ModelReviewResult }
  | {
      readonly outcome: "incomplete";
      readonly incomplete: v.InferOutput<typeof incompleteAnalysisSchema>;
    };

/** Both/neither payloads, extra keys, and malformed results remain invalid results. */
export function parseAnalysisInvocationOutcome(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the provider envelope is unvalidated; this parser owns its shape and cross-field contract.
  input: unknown,
): Result<AnalysisInvocationOutcome, "invalid_result"> {
  const parsed = v.safeParse(analysisInvocationOutcomeSchema, input);
  if (!parsed.success) return err("invalid_result");
  const value = parsed.output;
  if (
    value.outcome === "incomplete" &&
    value.result === null &&
    value.incomplete !== null
  )
    return ok({ outcome: "incomplete", incomplete: value.incomplete });
  if (
    value.outcome !== "complete" ||
    value.result === null ||
    value.incomplete !== null
  )
    return err("invalid_result");
  const result = parseModelReviewResult(value.result);
  return result._tag === "ok"
    ? ok({ outcome: "complete", result: result.value })
    : err("invalid_result");
}
