import * as v from "valibot";

import {
  incompleteAnalysisSchema,
  type AnalysisInvocationOutcome,
} from "#src/domain/analysis-invocation-outcome";
import { parseModelReviewResult } from "#src/domain/review-result";
import { err, ok, type Result } from "#src/domain/result";
import { parseCodexStrictResult } from "./codex-output-schema";

const piAnalysisEnvelopeSchema = v.variant("outcome", [
  v.strictObject({
    outcome: v.literal("complete"),
    result: v.unknown(),
    incomplete: v.exactOptional(v.null()),
  }),
  v.strictObject({
    outcome: v.literal("incomplete"),
    result: v.exactOptional(v.null()),
    incomplete: incompleteAnalysisSchema,
  }),
]);

/** Pi has no strict schema channel, so its inactive outcome payload may be absent. */
export function parsePiCliAnalysisOutcome(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi returns unvalidated JSON; this boundary owns its outcome and payload contracts.
  input: unknown,
): Result<AnalysisInvocationOutcome, "invalid_result"> {
  const envelope = v.safeParse(piAnalysisEnvelopeSchema, input);
  if (!envelope.success) return err("invalid_result");
  if (envelope.output.outcome === "incomplete")
    return ok({
      outcome: "incomplete",
      incomplete: envelope.output.incomplete,
    });
  // Preserve native optional-result null handling shared with Brief decoding.
  const result = parseModelReviewResult(
    parseCodexStrictResult(envelope.output.result),
  );
  return result._tag === "ok"
    ? ok({ outcome: "complete", result: result.value })
    : err("invalid_result");
}
