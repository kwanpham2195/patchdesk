import * as v from "valibot";
import { parseWorkspaceProfileId, parseReviewId } from "#src/domain/ids";
import {
  insightArtifactReferenceSchema as R,
  insightArtifactUnsignedSchema as U,
  encodeInsightArtifactCanonicalJson,
} from "#src/domain/insight-artifact-scalars";
import { walkthroughPreparedInputCodec } from "#src/domain/walkthrough-preparation";
import { walkthroughRuntimeCodec } from "#src/domain/walkthrough-result";
import { PatchdeskPaths } from "./patchdesk-paths";
import { InsightArtifactStore } from "./insight-artifact-store";
import { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import { validateExplanationPreparedEvidence } from "./explanation-prepared-evidence-validation";
import { validateWalkthroughPreparedHunks } from "./walkthrough-prepared-hunks-validation";
import { WalkthroughReceiptReplay } from "./walkthrough-receipt-replay";
import { WalkthroughGraphWriter } from "./walkthrough-result-graph";
import type {
  GuideValidationInput,
  GuideValidationFailureReason,
} from "./guide-result-job";

/** Descriptor-only private worker reply. */
export const walkthroughValidationResultSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("ok"),
    value: v.strictObject({
      result: R,
      validation: R,
      counts: v.strictObject({
        chapters: U,
        sections: U,
        citedHunks: U,
        uncited: U,
        receipts: U,
      }),
    }),
  }),
  v.strictObject({
    _tag: v.literal("err"),
    error: v.strictObject({
      _tag: v.literal("WalkthroughValidationFailure"),
      reason: v.picklist([
        "aborted",
        "invalid_input",
        "rejected",
        "io",
        "transport",
        "busy",
      ]),
    }),
  }),
]);
/** Worker reply never carries a complete result graph. */
export type WalkthroughValidationResult = v.InferOutput<
  typeof walkthroughValidationResultSchema
>;
/** Prose-free worker failure. */
export function walkthroughValidationFailure(
  reason: GuideValidationFailureReason,
): Extract<WalkthroughValidationResult, { _tag: "err" }> {
  return {
    _tag: "err",
    error: { _tag: "WalkthroughValidationFailure", reason },
  };
}

/** Validates every prepared dependency before replaying and writing the result; it never publishes. */
export async function validateWalkthroughResult(
  input: GuideValidationInput,
  options: { readonly signal?: AbortSignal } = {},
): Promise<WalkthroughValidationResult> {
  const failure = (
    reason: GuideValidationFailureReason,
  ): WalkthroughValidationResult =>
    walkthroughValidationFailure(options.signal?.aborted ? "aborted" : reason);
  const profile = parseWorkspaceProfileId(input.profileId);
  const review = parseReviewId(input.reviewId);
  if (profile._tag === "err" || review._tag === "err")
    return failure("invalid_input");
  const paths = PatchdeskPaths.fromEnvironment({
    PATCHDESK_CONFIG_DIRECTORY: input.destinationRoot,
    PATCHDESK_DATA_DIRECTORY: input.destinationRoot,
    PATCHDESK_CACHE_DIRECTORY: input.destinationRoot,
  });
  const artifacts = new InsightArtifactStore(
    paths,
    readBoundedInsightArtifactFile,
  );
  try {
    if (options.signal?.aborted) return failure("aborted");
    const [runtime, prepared] = await Promise.all([
      artifacts.readObject(
        profile.value,
        review.value,
        walkthroughRuntimeCodec,
        input.runtime,
      ),
      artifacts.readObject(
        profile.value,
        review.value,
        walkthroughPreparedInputCodec,
        input.preparation,
      ),
    ]);
    if (runtime._tag === "err" || prepared._tag === "err")
      return failure("rejected");
    const frozen = runtime.value.frozen;
    if (
      runtime.value.phase !== "validating" ||
      runtime.value.result !== null ||
      frozen === null ||
      frozen.sequence !== frozen.receipts.count ||
      encodeInsightArtifactCanonicalJson(frozen.receipts) !==
        encodeInsightArtifactCanonicalJson(runtime.value.receipts) ||
      encodeInsightArtifactCanonicalJson(runtime.value.preparation) !==
        encodeInsightArtifactCanonicalJson(input.preparation) ||
      encodeInsightArtifactCanonicalJson(prepared.value.binding) !==
        encodeInsightArtifactCanonicalJson(input.binding)
    )
      return failure("rejected");
    if (
      !(await validateExplanationPreparedEvidence(
        artifacts,
        paths,
        {
          profileId: profile.value,
          reviewId: review.value,
          runId: input.runId,
        },
        prepared.value,
        options,
        "walkthrough",
      ))
    )
      return failure("rejected");
    const hunks = await validateWalkthroughPreparedHunks(
      artifacts,
      { profileId: profile.value, reviewId: review.value },
      prepared.value,
      options,
    );
    if (hunks._tag === "err") return failure("rejected");
    const graph = new WalkthroughGraphWriter(
      artifacts,
      profile.value,
      review.value,
      input,
      prepared.value,
      options,
    );
    if (!(await graph.initialize())) return failure("io");
    const replayed = await new WalkthroughReceiptReplay(
      artifacts,
      profile.value,
      review.value,
      input,
      options,
    ).replay(frozen.receipts, hunks.value, true, (payload, result) =>
      graph.emit(payload, result),
    );
    if (replayed._tag === "err")
      return failure(replayed.error === "rejected" ? "rejected" : "io");
    const result = await graph.finish(frozen);
    return result === undefined ? failure("io") : { _tag: "ok", value: result };
  } catch {
    return failure(options.signal?.aborted ? "aborted" : "io");
  }
}
