import * as v from "valibot";

import type { InsightArtifactCodec } from "./insight-artifact-index";
import {
  insightArtifactHashSchema,
  insightArtifactReferenceSchema,
  insightArtifactUnsignedSchema,
  insightTextRootDescriptorSchema,
} from "./insight-artifact-scalars";

/** Guide preparation refuses a larger captured patch before reading it; this is an input bound, not a memory promise. */
export const GUIDE_MAX_PATCH_BYTES = 64 * 1024 * 1024;

/** Counts are the known prefix omitted from advisory context, never an upstream total. */
export const guideContextCompletenessSchema = v.strictObject({
  knownOmittedChecks: insightArtifactUnsignedSchema,
  knownOmittedThreads: insightArtifactUnsignedSchema,
  knownOmittedRules: insightArtifactUnsignedSchema,
  upstreamCompleteness: v.picklist(["complete", "partial", "unknown"]),
});

const guidePreparedInputSchema = v.strictObject({
  binding: insightArtifactReferenceSchema,
  patch: insightTextRootDescriptorSchema,
  inventory: insightTextRootDescriptorSchema,
  context: insightTextRootDescriptorSchema,
  evidenceManifest: insightTextRootDescriptorSchema,
  evidenceBundleId: insightArtifactHashSchema,
  entryPageId: insightTextRootDescriptorSchema,
  contextCompleteness: guideContextCompletenessSchema,
});

/** Closed wrapper for everything Guide preparation verified before generation; it carries no provider or result state. */
export const guidePreparedInputCodec: InsightArtifactCodec<
  typeof guidePreparedInputSchema
> = { name: "GuidePreparedInput1", schema: guidePreparedInputSchema };

/** Parsed GuidePreparedInput1; its text roots are verified by the preparation job, not by this parser. */
export type GuidePreparedInput = v.InferOutput<typeof guidePreparedInputSchema>;

/** Whether the upstream comment and check lists are known to be whole. */
export type GuideUpstreamCompleteness =
  GuidePreparedInput["contextCompleteness"]["upstreamCompleteness"];

/** Safe categories for a failed preparation; none carries source prose or paths. */
const GUIDE_PREPARATION_FAILURE_REASONS = [
  "aborted",
  "invalid_source",
  "stale_source",
  "sensitive_value",
  "too_large",
  "not_indexable",
  /** A required context source (a configured rule, comments or checks) was unreadable, sensitive or absent. */
  "context_unavailable",
  /** The run could not be durably settled; this process still owns it and a retry reconciles it. */
  "unsettled",
  "io",
  "transport",
  "busy",
] as const;

/** One failed-preparation category. */
export type GuidePreparationFailureReason =
  (typeof GUIDE_PREPARATION_FAILURE_REASONS)[number];

/** Finite counts the job returns beside the prepared root for diagnostics. */
const guidePreparationCountsSchema = v.strictObject({
  patchBytes: insightArtifactUnsignedSchema,
  inventoryFiles: insightArtifactUnsignedSchema,
  contextBytes: insightArtifactUnsignedSchema,
  evidenceSources: insightArtifactUnsignedSchema,
  evidencePages: insightArtifactUnsignedSchema,
});

/** Descriptor-only preparation reply shared by the worker and sandboxed preload. */
export const guidePreparationResultSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("ok"),
    value: v.strictObject({
      root: insightArtifactReferenceSchema,
      counts: guidePreparationCountsSchema,
    }),
  }),
  v.strictObject({
    _tag: v.literal("err"),
    error: v.strictObject({
      _tag: v.literal("GuidePreparationFailure"),
      reason: v.picklist(GUIDE_PREPARATION_FAILURE_REASONS),
    }),
  }),
]);

/** Host-captured context that does not depend on the patch; the preparation job adds the changed files and renders it. */
export const guideContextInputSchema = v.strictObject({
  pr: v.strictObject({
    repository: v.string(),
    source: v.string(),
    headSha: v.string(),
  }),
  comments: v.exactOptional(v.looseObject({ threads: v.array(v.unknown()) })),
  checks: v.exactOptional(
    v.looseObject({
      overall: v.exactOptional(v.unknown()),
      checks: v.exactOptional(v.array(v.unknown())),
    }),
  ),
  criteria: v.array(v.strictObject({ label: v.string(), text: v.string() })),
  packageSummary: v.looseObject({
    name: v.exactOptional(v.string()),
    packageManager: v.exactOptional(v.string()),
  }),
  omitted: v.strictObject({
    checks: insightArtifactUnsignedSchema,
    threads: insightArtifactUnsignedSchema,
  }),
  upstreamCompleteness: v.picklist(["complete", "partial", "unknown"]),
});

/** Parsed private context input for one Guide preparation. */
export type GuideContextInput = v.InferOutput<typeof guideContextInputSchema>;
