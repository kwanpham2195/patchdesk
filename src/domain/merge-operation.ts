import * as v from "valibot";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type GitSha,
  type IsoTimestamp,
  type PullRequestNumber,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";

type MergeMethod = "merge" | "squash" | "rebase";

type MergeRejectionReason =
  | "invalid_input"
  | "not_found"
  | "stale_head"
  | "merge_blocked"
  | "merge_acknowledgement_required"
  | "merge_forbidden"
  | "merge_failed";

type MergeOperationState =
  | { readonly _tag: "Requested" }
  | { readonly _tag: "OutcomeUnknown" }
  | {
      readonly _tag: "Confirmed";
      readonly mergedAt: IsoTimestamp;
      readonly mergeCommitSha?: GitSha;
    }
  | { readonly _tag: "Rejected"; readonly reason: MergeRejectionReason };

export type MergeOperation = {
  readonly operationId: string;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly pr: {
    readonly host: GitHubHost;
    readonly owner: GitHubOwner;
    readonly repo: GitHubRepoName;
    readonly number: PullRequestNumber;
  };
  readonly expectedHeadSha: GitSha;
  readonly method: MergeMethod;
  readonly acknowledgedWarningCodes: ReadonlyArray<string>;
  readonly startedAt: IsoTimestamp;
  readonly state: MergeOperationState;
};

export type InvalidMergeOperation = { readonly _tag: "InvalidMergeOperation" };

const rejectionReasons = [
  "invalid_input",
  "not_found",
  "stale_head",
  "merge_blocked",
  "merge_acknowledgement_required",
  "merge_forbidden",
  "merge_failed",
] as const;

const operationSchema = v.strictObject({
  operationId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,128}$/)),
  profileId: v.string(),
  reviewId: v.string(),
  sessionId: v.string(),
  pr: v.strictObject({
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    number: v.number(),
  }),
  expectedHeadSha: v.string(),
  method: v.picklist(["merge", "squash", "rebase"]),
  acknowledgedWarningCodes: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(80))),
    v.maxLength(32),
  ),
  startedAt: v.string(),
  state: v.variant("_tag", [
    v.strictObject({ _tag: v.literal("Requested") }),
    v.strictObject({ _tag: v.literal("OutcomeUnknown") }),
    v.strictObject({
      _tag: v.literal("Confirmed"),
      mergedAt: v.string(),
      mergeCommitSha: v.optional(v.string()),
    }),
    v.strictObject({
      _tag: v.literal("Rejected"),
      reason: v.picklist(rejectionReasons),
    }),
  ]),
});

/** Parses persisted merge-operation evidence without admitting provider payloads or free-form errors. */
export function parseMergeOperation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON merge-operation I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): Result<MergeOperation, InvalidMergeOperation> {
  const raw = v.safeParse(operationSchema, input);
  if (!raw.success) return invalid();
  const profileId = parseWorkspaceProfileId(raw.output.profileId);
  const reviewId = parseReviewId(raw.output.reviewId);
  const sessionId = parseReviewSessionId(raw.output.sessionId);
  const host = parseGitHubHost(raw.output.pr.host);
  const owner = parseGitHubOwner(raw.output.pr.owner);
  const repo = parseGitHubRepoName(raw.output.pr.repo);
  const number = parsePullRequestNumber(raw.output.pr.number);
  const expectedHeadSha = parseGitSha(raw.output.expectedHeadSha);
  const startedAt = parseIsoTimestamp(raw.output.startedAt);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    sessionId._tag === "err" ||
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err" ||
    expectedHeadSha._tag === "err" ||
    startedAt._tag === "err"
  )
    return invalid();
  const state = parseState(raw.output.state);
  if (state._tag === "err") return state;
  return ok({
    ...raw.output,
    profileId: profileId.value,
    reviewId: reviewId.value,
    sessionId: sessionId.value,
    pr: {
      host: host.value,
      owner: owner.value,
      repo: repo.value,
      number: number.value,
    },
    expectedHeadSha: expectedHeadSha.value,
    startedAt: startedAt.value,
    state: state.value,
  });
}

/** Creates durable merge intent before any remote merge call starts. */
export function requestMergeOperation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- delegates straight to parseMergeOperation, itself the JSON merge-operation I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): Result<MergeOperation, InvalidMergeOperation> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external input at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  )
    return invalid();
  return parseMergeOperation({ ...input, state: { _tag: "Requested" } });
}

/** Marks the precise crash boundary after a remote merge call becomes possible. */
export function markMergeOutcomeUnknown(
  operation: MergeOperation,
): Result<MergeOperation, InvalidMergeOperation> {
  return operation.state._tag === "Requested"
    ? ok({ ...operation, state: { _tag: "OutcomeUnknown" } })
    : invalid();
}

/** Records a confirmed GitHub merge receipt without retaining response bodies. */
export function confirmMergeOperation(
  operation: MergeOperation,
  mergedAt: IsoTimestamp,
  mergeCommitSha?: GitSha,
): Result<MergeOperation, InvalidMergeOperation> {
  const mergeCommitShaField =
    mergeCommitSha === undefined ? {} : { mergeCommitSha };
  return operation.state._tag === "OutcomeUnknown"
    ? ok({
        ...operation,
        state: {
          _tag: "Confirmed",
          mergedAt,
          ...mergeCommitShaField,
        },
      })
    : invalid();
}

/** Records a finite merge rejection from before or during the remote operation. */
export function rejectMergeOperation(
  operation: MergeOperation,
  reason: string,
): Result<MergeOperation, InvalidMergeOperation> {
  if (
    (operation.state._tag !== "Requested" &&
      operation.state._tag !== "OutcomeUnknown") ||
    // SAFETY: `rejectionReasons` is a tuple of string literals, so `Array.includes`
    // requires an argument of that same literal union; this assertion only
    // satisfies that signature, and this call's own boolean result is the actual
    // runtime membership check — reason is trusted as MergeRejectionReason only
    // once this condition has returned false (see the return below).
    !rejectionReasons.includes(reason as MergeRejectionReason)
  )
    return invalid();
  return ok({
    ...operation,
    // SAFETY: the guard above already proved `rejectionReasons.includes(reason)`;
    // this assertion only restates that proof for the compiler.
    state: { _tag: "Rejected", reason: reason as MergeRejectionReason },
  });
}

function parseState(
  input: v.InferOutput<typeof operationSchema>["state"],
): Result<MergeOperationState, InvalidMergeOperation> {
  if (input._tag !== "Confirmed") return ok(input);
  const mergedAt = parseIsoTimestamp(input.mergedAt);
  const mergeCommitSha =
    input.mergeCommitSha === undefined
      ? undefined
      : parseGitSha(input.mergeCommitSha);
  if (
    mergedAt._tag === "err" ||
    (mergeCommitSha !== undefined && mergeCommitSha._tag === "err")
  )
    return invalid();
  const mergeCommitShaField =
    mergeCommitSha === undefined
      ? {}
      : { mergeCommitSha: mergeCommitSha.value };
  return ok({
    _tag: "Confirmed",
    mergedAt: mergedAt.value,
    ...mergeCommitShaField,
  });
}

function invalid(): Result<never, InvalidMergeOperation> {
  return err({ _tag: "InvalidMergeOperation" });
}
