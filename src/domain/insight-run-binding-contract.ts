import * as v from "valibot";

import type { InsightArtifactCodec } from "./insight-artifact-index";
import {
  insightArtifactGitShaSchema,
  insightArtifactHashSchema,
  insightArtifactIdSchema,
  insightArtifactIndexDescriptorSchema,
  insightArtifactPositiveSchema,
  insightArtifactReferenceSchema,
  insightArtifactRunIdSchema,
  insightArtifactTimeSchema,
  insightArtifactUnsignedSchema,
  insightTextRootDescriptorSchema,
} from "./insight-artifact-scalars";

// Closed schemas from astra-contract-r2 with the same names; objects without a codec yet (IntentProvenance, UsageEntry) stay R<X>/I<X> descriptors.

const textRootSchema = insightTextRootDescriptorSchema;
const kindSchema = v.picklist(["brief", "walkthrough", "analysis", "guide"]);
const providerSchema = v.picklist([
  "pi",
  "codex-cli-account",
  "pi-cli-account",
]);

const domainIdentitySchema = v.strictObject({
  profileId: textRootSchema,
  reviewId: textRootSchema,
  sessionId: textRootSchema,
  runId: textRootSchema,
});

const reviewSourceSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("pull_request"),
    prNumber: insightArtifactPositiveSchema,
  }),
  v.strictObject({
    kind: v.literal("working_tree"),
    branch: v.exactOptional(textRootSchema),
    checkout: v.exactOptional(textRootSchema),
  }),
  v.strictObject({
    kind: v.literal("branch"),
    branch: textRootSchema,
    baseBranch: textRootSchema,
    checkout: v.exactOptional(textRootSchema),
  }),
  v.strictObject({
    kind: v.literal("local_branch"),
    branch: textRootSchema,
    baseRef: textRootSchema,
    checkout: v.exactOptional(textRootSchema),
  }),
  v.strictObject({
    kind: v.literal("commit"),
    commitSha: insightArtifactGitShaSchema,
    checkout: v.exactOptional(textRootSchema),
  }),
]);

const bindingSchema = v.strictObject({
  identityId: insightArtifactIdSchema,
  identity: insightArtifactReferenceSchema,
  kind: kindSchema,
  baseSha: insightArtifactGitShaSchema,
  headSha: insightArtifactGitShaSchema,
  patchHash: insightArtifactHashSchema,
  source: insightArtifactReferenceSchema,
  captureId: insightArtifactIdSchema,
});

const reasoningSchema = v.picklist([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const provenanceSchema = v.strictObject({
  provider: providerSchema,
  model: textRootSchema,
  reasoning: reasoningSchema,
  language: v.picklist(["en", "vi"]),
  changeIntent: v.exactOptional(insightArtifactReferenceSchema),
  origin: v.picklist(["generated", "migrated"]),
  legacySourceHash: v.exactOptional(insightArtifactHashSchema),
});

// The contract's legacy variant carries a migrated deadline and has no producer yet, so only the new policy is accepted.
const runPolicySchema = v.strictObject({
  kind: v.literal("no-total-deadline/1"),
});

const authorizationSchema = v.strictObject({
  id: insightArtifactIdSchema,
  runId: insightArtifactRunIdSchema,
  kind: v.picklist(["start", "resume"]),
  policy: insightArtifactReferenceSchema,
  selection: insightArtifactReferenceSchema,
  authorizedAt: insightArtifactTimeSchema,
  previous: v.nullable(insightArtifactIdSchema),
  possibleSpendAcknowledged: v.boolean(),
  unknownDispatchDisposition: v.nullable(textRootSchema),
});

/** The r1 fixed code column plus the four r2 §4 additions. */
const errorCodeSchema = v.picklist([
  "invalid_schema",
  "envelope_too_large",
  "invalid_field",
  "invalid_reference",
  "op_conflict",
  "fragment_conflict",
  "version_conflict",
  "draft_mismatch",
  "stale_generation",
  "cancelled",
  "superseded",
  "candidate_sealed",
  "cursor_invalid",
  "cursor_expired",
  "draft_open",
  "unresolved_work",
  "validation_rejected",
  "evidence_missing",
  "evidence_changed",
  "artifact_corrupt",
  "storage_unavailable",
  "resource_exhausted",
  "representation_exhausted",
  "producer_unsettled",
  "paid_dispatch_unknown",
  "capability_unavailable",
  "provider_refused",
  "validation_pending",
  "orphan_unit",
  "relation_conflict",
  "identity_conflict",
  "view_stale",
]);

const failureRecordSchema = v.strictObject({
  code: errorCodeSchema,
  phase: v.picklist([
    "capture",
    "generation",
    "ingestion",
    "checkpoint",
    "seal",
    "validation",
    "publication",
    "migration",
    "restore",
  ]),
  at: insightArtifactTimeSchema,
  lastDurableSequence: insightArtifactUnsignedSchema,
  recovery: v.picklist(["resume_required", "terminal"]),
  detail: v.exactOptional(textRootSchema),
});

const legacyFailureSchema = v.strictObject({
  runId: textRootSchema,
  reason: v.picklist(["cancelled", "failed", "invalid_result", "superseded"]),
  category: v.exactOptional(textRootSchema),
  provider: providerSchema,
  model: textRootSchema,
  reasoning: reasoningSchema,
  retryable: v.boolean(),
  failedAt: insightArtifactTimeSchema,
});

const usageRootSchema = v.strictObject({
  entries: insightArtifactIndexDescriptorSchema,
  knownInputTokens: insightArtifactUnsignedSchema,
  knownOutputTokens: insightArtifactUnsignedSchema,
  knownCacheReadTokens: insightArtifactUnsignedSchema,
  knownCacheWriteTokens: insightArtifactUnsignedSchema,
  knownMicroUsd: insightArtifactUnsignedSchema,
  hasUnknownUsage: v.boolean(),
});

/** DomainIdentity: the Review's profile, Review, session and run IDs as TextRoot; the reader checks each against its `ids.ts` parser. */
export const insightDomainIdentityCodec: InsightArtifactCodec<
  typeof domainIdentitySchema
> = { name: "DomainIdentity", schema: domainIdentitySchema };

/** ReviewSource: variants and optional fields follow `review-source.ts`; branch and checkout text is parsed by the reader. */
export const insightReviewSourceCodec: InsightArtifactCodec<
  typeof reviewSourceSchema
> = { name: "ReviewSource", schema: reviewSourceSchema };

/** Binding: `captureId` is issued at admission; the CaptureRoot it names is committed later. */
export const insightBindingCodec: InsightArtifactCodec<typeof bindingSchema> = {
  name: "Binding",
  schema: bindingSchema,
};

/** Provenance: the selected provider, model and language; `changeIntent` stays an R<IntentProvenance> descriptor. */
export const insightProvenanceCodec: InsightArtifactCodec<
  typeof provenanceSchema
> = { name: "Provenance", schema: provenanceSchema };

/** RunPolicy: only `no-total-deadline/1`; the legacy variant waits for the slice that migrates a deadline. */
export const insightRunPolicyCodec: InsightArtifactCodec<
  typeof runPolicySchema
> = { name: "RunPolicy", schema: runPolicySchema };

/** Authorization: `runId` must also pass `parseInsightRunId`. */
export const insightAuthorizationCodec: InsightArtifactCodec<
  typeof authorizationSchema
> = { name: "Authorization", schema: authorizationSchema };

/** FailureRecord: `code` is the closed ErrorCode set. */
export const insightFailureRecordCodec: InsightArtifactCodec<
  typeof failureRecordSchema
> = { name: "FailureRecord", schema: failureRecordSchema };

/** LegacyFailure: a slot's replacement failure; `category` text must equal one of the existing failure categories. */
export const insightLegacyFailureCodec: InsightArtifactCodec<
  typeof legacyFailureSchema
> = { name: "LegacyFailure", schema: legacyFailureSchema };

/** UsageRoot: counters are known values only; `entries` indexes UsageEntry, which has no codec yet. */
export const insightUsageRootCodec: InsightArtifactCodec<
  typeof usageRootSchema
> = { name: "UsageRoot", schema: usageRootSchema };

/** Parsed FailureRecord; `code` is the closed ErrorCode set. */
export type InsightFailureRecord = v.InferOutput<typeof failureRecordSchema>;
