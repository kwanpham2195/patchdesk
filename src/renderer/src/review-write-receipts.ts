import * as v from "valibot";

import { GITHUB_LOGIN_MAX_LENGTH, parseGitHubLogin } from "../../domain/ids";

export const mergeReadinessSchema = v.strictObject({
  _tag: v.picklist(["Ready", "Blocked", "NeedsAcknowledgement"]),
  blockers: v.array(v.string()),
  warnings: v.array(v.string()),
});

const mergeReceiptSchema = v.strictObject({
  readiness: mergeReadinessSchema,
  mergeCommitSha: v.optional(
    v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u, "invalid Git SHA")),
  ),
});

/** Strict renderer projection of a confirmed merge command response. */
export type MergeReceipt = v.InferOutput<typeof mergeReceiptSchema>;

/** Rejects malformed merge confirmation before terminal renderer state changes. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the JSON I/O boundary parser; no earlier parser can establish the receipt shape.
export function parseMergeReceipt(input: unknown): MergeReceipt | undefined {
  const parsed = v.safeParse(mergeReceiptSchema, input);
  return parsed.success ? parsed.output : undefined;
}

export const remoteWriteRecoverySchema = v.strictObject({
  operation: v.picklist([
    "CreateComment",
    "Reply",
    "SetThreadState",
    "EditComment",
    "DeleteComment",
    "AddLabels",
    "RemoveLabels",
    "AddAssignees",
    "RemoveAssignees",
    "RequestReviewers",
    "RemoveReviewers",
    "EditPublishedComment",
    "DeletePublishedComment",
    "DismissPublishedReview",
  ]),
  resolution: v.picklist(["check_required", "manual_resolution_required"]),
});

export const viewerLoginSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(GITHUB_LOGIN_MAX_LENGTH),
  v.check(
    (value) => parseGitHubLogin(value)._tag === "ok",
    "invalid GitHub login",
  ),
);
