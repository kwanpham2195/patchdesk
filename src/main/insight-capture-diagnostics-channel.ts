import * as v from "valibot";
import { guidePreparationResultSchema } from "#src/domain/guide-preparation";
import { insightTextRootDescriptorSchema } from "#src/domain/insight-artifact-scalars";
import {
  INSIGHT_LANGUAGES,
  INSIGHT_PROVIDERS,
} from "#src/domain/insight-provider";
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
    action: v.picklist(["stage", "prepare_guide", "status", "cancel"]),
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
    /** Names the run's provenance for admission; it never authorizes a provider dispatch. */
    selection: v.exactOptional(
      v.strictObject({
        provider: v.picklist(INSIGHT_PROVIDERS),
        model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        reasoning: v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
        language: v.picklist(INSIGHT_LANGUAGES),
      }),
    ),
  }),
  v.check(
    (request) =>
      (request.action === "prepare_guide") ===
      (request.selection !== undefined),
    "Only a Guide preparation names a selection, and it must.",
  ),
  v.check((request) => {
    // Include the channel and complete invoke argument, not only selected identity fields.
    return (
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
      "cancel_failed",
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
            "too_large",
            "io",
            "transport",
            "busy",
          ]),
        }),
      }),
    ]),
  }),
  v.strictObject({
    status: v.literal("guide_settled"),
    /** True while the prepared run is still active and owned by this process, until cancel or disposal. */
    owned: v.boolean(),
    result: guidePreparationResultSchema,
  }),
]);

/** Runtime-validated response from the authenticated main-process handler. */
export type InsightCaptureDiagnosticReply = v.InferOutput<
  typeof insightCaptureDiagnosticReplySchema
>;
