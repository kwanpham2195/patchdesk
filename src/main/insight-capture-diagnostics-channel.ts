import * as v from "valibot";
import { insightTextRootDescriptorSchema } from "#src/domain/insight-artifact-scalars";
import {
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "#src/domain/ids";

/** Development-only channel; both privileged bundles eliminate its consumers in production. */
export const INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL =
  "patchdesk:insight-patch-capture-diagnostic";

/** Requests name the startup-selected Review and exact revision, never filesystem locations. */
export const insightCaptureDiagnosticRequestSchema = v.pipe(
  v.strictObject({
    action: v.picklist(["stage", "status", "cancel"]),
    profileId: v.pipe(
      v.string(),
      v.check((value) => parseWorkspaceProfileId(value)._tag === "ok"),
    ),
    reviewId: v.pipe(
      v.string(),
      v.check((value) => parseReviewId(value)._tag === "ok"),
    ),
    sessionId: v.pipe(
      v.string(),
      v.check((value) => parseReviewSessionId(value)._tag === "ok"),
    ),
    revision: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    patchHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  }),
  v.check((request) => {
    // Include the channel and complete invoke argument, not only selected identity fields.
    return (
      Object.values(request).reduce(
        (sum, value) => sum + value.length,
        INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL.length,
      ) <=
        32 * 1024 &&
      new TextEncoder().encode(
        JSON.stringify([INSIGHT_CAPTURE_DIAGNOSTIC_CHANNEL, request]),
      ).length <=
        32 * 1024
    );
  }),
);

/** Parsed command to one diagnostic operation. */
export type InsightCaptureDiagnosticRequest = v.InferOutput<
  typeof insightCaptureDiagnosticRequestSchema
>;

/** Bounded diagnostic states contain only descriptors and safe categories, never source prose. */
export const insightCaptureDiagnosticReplySchema = v.variant("status", [
  v.strictObject({ status: v.picklist(["idle", "running", "cancelling"]) }),
  v.strictObject({
    status: v.literal("rejected"),
    reason: v.picklist([
      "unauthorized",
      "invalid_request",
      "already_started",
      "transport",
    ]),
  }),
  v.strictObject({
    status: v.literal("settled"),
    result: v.variant("_tag", [
      v.strictObject({
        _tag: v.literal("ok"),
        value: insightTextRootDescriptorSchema,
      }),
      v.strictObject({
        _tag: v.literal("err"),
        error: v.strictObject({
          _tag: v.literal("InsightPatchFailure"),
          reason: v.picklist([
            "aborted",
            "invalid_source",
            "stale_source",
            "sensitive_value",
            "io",
            "transport",
            "busy",
          ]),
        }),
      }),
    ]),
  }),
]);

/** Runtime-validated response from the authenticated main-process handler. */
export type InsightCaptureDiagnosticReply = v.InferOutput<
  typeof insightCaptureDiagnosticReplySchema
>;
