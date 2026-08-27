import * as v from "valibot";

import {
  parseGitHubReviewRestId,
  parseGitSha,
  parseIsoTimestamp,
  type GitHubReviewRestId,
  type GitSha,
  type IsoTimestamp,
} from "./ids";
import type { GitHubReviewEvent } from "./pending-review";
import { err, ok, type Result } from "./result";

type DirectSummaryReviewOperation = {
  readonly requestId: string;
  readonly event: GitHubReviewEvent;
  /** SHA-256 of the body; summary text is never persisted as a local draft. */
  readonly bodyDigest: string;
  readonly headSha: GitSha;
  readonly baselineReviewIds: ReadonlyArray<GitHubReviewRestId>;
  readonly startedAt: IsoTimestamp;
};

export type DirectSummaryReviewReceipt = {
  readonly reviewId: GitHubReviewRestId;
  readonly event: GitHubReviewEvent;
  readonly headSha: GitSha;
  readonly submittedAt: IsoTimestamp;
};

/** Durable evidence for a one-shot, immediately published review summary. */
export type DirectSummaryReviewState =
  | {
      readonly _tag: "WriteInFlight";
      readonly operation: DirectSummaryReviewOperation;
    }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly operation: DirectSummaryReviewOperation;
      readonly resolution: "check_required" | "manual_resolution_required";
    }
  | {
      readonly _tag: "Confirmed";
      readonly receipt: DirectSummaryReviewReceipt;
    };

export type InvalidDirectSummaryReviewState = {
  readonly _tag: "InvalidDirectSummaryReviewState";
};

const operationSchema = v.strictObject({
  requestId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  bodyDigest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  headSha: v.string(),
  baselineReviewIds: v.array(v.string()),
  startedAt: v.string(),
});
const stateSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("WriteInFlight"),
    operation: operationSchema,
  }),
  v.strictObject({
    _tag: v.literal("OutcomeUnknown"),
    operation: operationSchema,
    resolution: v.picklist(["check_required", "manual_resolution_required"]),
  }),
  v.strictObject({
    _tag: v.literal("Confirmed"),
    receipt: v.strictObject({
      reviewId: v.string(),
      event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
      headSha: v.string(),
      submittedAt: v.string(),
    }),
  }),
]);

export function parseDirectSummaryReviewState(
  input: unknown,
): Result<DirectSummaryReviewState, InvalidDirectSummaryReviewState> {
  const parsed = v.safeParse(stateSchema, input);
  if (!parsed.success) return invalid();
  if (parsed.output._tag === "Confirmed") {
    const reviewId = parseGitHubReviewRestId(parsed.output.receipt.reviewId);
    const headSha = parseGitSha(parsed.output.receipt.headSha);
    const submittedAt = parseIsoTimestamp(parsed.output.receipt.submittedAt);
    return reviewId._tag === "err" ||
      headSha._tag === "err" ||
      submittedAt._tag === "err"
      ? invalid()
      : ok({
          _tag: "Confirmed",
          receipt: {
            reviewId: reviewId.value,
            event: parsed.output.receipt.event,
            headSha: headSha.value,
            submittedAt: submittedAt.value,
          },
        });
  }
  const operation = parseOperation(parsed.output.operation);
  if (operation._tag === "err") return invalid();
  return parsed.output._tag === "OutcomeUnknown"
    ? ok({
        _tag: "OutcomeUnknown",
        operation: operation.value,
        resolution: parsed.output.resolution,
      })
    : ok({ _tag: "WriteInFlight", operation: operation.value });
}

function parseOperation(
  input: v.InferOutput<typeof operationSchema>,
): Result<DirectSummaryReviewOperation, InvalidDirectSummaryReviewState> {
  const headSha = parseGitSha(input.headSha);
  const startedAt = parseIsoTimestamp(input.startedAt);
  const baselineReviewIds = input.baselineReviewIds.map(
    parseGitHubReviewRestId,
  );
  if (headSha._tag === "err" || startedAt._tag === "err") return invalid();
  const ids: GitHubReviewRestId[] = [];
  for (const id of baselineReviewIds) {
    if (id._tag === "err") return invalid();
    ids.push(id.value);
  }
  return ok({
    requestId: input.requestId,
    event: input.event,
    bodyDigest: input.bodyDigest,
    headSha: headSha.value,
    baselineReviewIds: ids,
    startedAt: startedAt.value,
  });
}

function invalid(): Result<never, InvalidDirectSummaryReviewState> {
  return err({ _tag: "InvalidDirectSummaryReviewState" });
}
