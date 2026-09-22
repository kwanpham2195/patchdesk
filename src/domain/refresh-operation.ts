import * as v from "valibot";

import {
  parseContentHash,
  parseIsoTimestamp,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ContentHash,
  type IsoTimestamp,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";
import { parseReview, type Review } from "./review";

type RefreshOperationFailure =
  | "github_read"
  | "github_auth"
  | "not_found"
  | "storage"
  | "head_changed"
  | "terminal";

type RefreshOperationState =
  | { readonly _tag: "Requested" }
  | {
      readonly _tag: "Prepared";
      readonly nextReview: Review;
      readonly sessionId: ReviewSessionId;
      readonly snapshotHash: ContentHash;
    }
  | { readonly _tag: "Completed" }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Failed"; readonly reason: RefreshOperationFailure };

/** Durable evidence for one accepted Review refresh. Prepared contains the exact Review CAS will persist. */
export type RefreshOperation = {
  readonly operationId: string;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expectedUpdatedAt: IsoTimestamp;
  readonly startedAt: IsoTimestamp;
  readonly state: RefreshOperationState;
};

export type InvalidRefreshOperation = {
  readonly _tag: "InvalidRefreshOperation";
};

const refreshFailureSchema = v.picklist([
  "github_read",
  "github_auth",
  "not_found",
  "storage",
  "head_changed",
  "terminal",
]);

const operationSchema = v.strictObject({
  operationId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,128}$/)),
  profileId: v.string(),
  reviewId: v.string(),
  expectedUpdatedAt: v.string(),
  startedAt: v.string(),
  state: v.variant("_tag", [
    v.strictObject({ _tag: v.literal("Requested") }),
    v.strictObject({
      _tag: v.literal("Prepared"),
      nextReview: v.unknown(),
      sessionId: v.string(),
      snapshotHash: v.pipe(v.string(), v.minLength(1)),
    }),
    v.strictObject({ _tag: v.literal("Completed") }),
    v.strictObject({ _tag: v.literal("Interrupted") }),
    v.strictObject({ _tag: v.literal("Failed"), reason: refreshFailureSchema }),
  ]),
});

/** Parses the refresh-operation JSON boundary without retaining provider bodies or free-form errors. */
export function parseRefreshOperation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the durable JSON I/O parser.
  input: unknown,
): Result<RefreshOperation, InvalidRefreshOperation> {
  const raw = v.safeParse(operationSchema, input);
  if (!raw.success) return invalid();
  const profileId = parseWorkspaceProfileId(raw.output.profileId);
  const reviewId = parseReviewId(raw.output.reviewId);
  const expectedUpdatedAt = parseIsoTimestamp(raw.output.expectedUpdatedAt);
  const startedAt = parseIsoTimestamp(raw.output.startedAt);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    expectedUpdatedAt._tag === "err" ||
    startedAt._tag === "err"
  )
    return invalid();
  const state = parseState(raw.output.state);
  if (state._tag === "err") return state;
  return ok({
    operationId: raw.output.operationId,
    profileId: profileId.value,
    reviewId: reviewId.value,
    expectedUpdatedAt: expectedUpdatedAt.value,
    startedAt: startedAt.value,
    state: state.value,
  });
}

function parseState(
  state: v.InferOutput<typeof operationSchema>["state"],
): Result<RefreshOperationState, InvalidRefreshOperation> {
  if (state._tag !== "Prepared") return ok(state);
  const nextReview = parseReview(state.nextReview);
  const sessionId = parseReviewSessionId(state.sessionId);
  const snapshotHash = parseContentHash(state.snapshotHash);
  if (
    nextReview._tag === "err" ||
    sessionId._tag === "err" ||
    snapshotHash._tag === "err"
  )
    return invalid();
  return ok({
    _tag: "Prepared",
    nextReview: nextReview.value,
    sessionId: sessionId.value,
    snapshotHash: snapshotHash.value,
  });
}

function invalid(): Result<never, InvalidRefreshOperation> {
  return err({ _tag: "InvalidRefreshOperation" });
}
