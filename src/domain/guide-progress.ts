import * as v from "valibot";

import { guideFileIdSchema, guideGroupIdSchema } from "./guide";
import type { InsightArtifactCodec } from "./insight-artifact-index";
import {
  insightArtifactGitShaSchema,
  insightArtifactHashSchema,
  insightArtifactIndexDescriptorSchema,
  insightArtifactPositiveSchema,
  insightArtifactReferenceSchema,
  insightArtifactUnsignedSchema,
  insightTextRootDescriptorSchema,
  parseInsightArtifactCanonicalJson,
} from "./insight-artifact-scalars";
import { parseReviewId, parseWorkspaceProfileId } from "./ids";
import { err, ok, type Result } from "./result";
import { INSIGHT_FAILURE_CATEGORIES } from "./insight-record";

// Reading progress records and the bounded page contract the renderer reads. Nothing here imports Node, so the
// sandboxed preload and the renderer can share these schemas.

const offsetSchema = v.pipe(v.number(), v.finite());
export const guideAppearanceGroupSchema = v.union([
  guideGroupIdSchema,
  v.literal("others"),
]);

export const guideAnchorSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("top") }),
  v.strictObject({
    kind: v.literal("group"),
    groupId: guideGroupIdSchema,
    offset: offsetSchema,
  }),
  v.strictObject({
    kind: v.literal("file"),
    groupId: guideAppearanceGroupSchema,
    fileId: guideFileIdSchema,
    offset: offsetSchema,
  }),
]);
/** The existing top/group/file anchor union with finite offsets. */
export type GuideAnchor = v.InferOutput<typeof guideAnchorSchema>;

/** Anchor text is canonical JSON so the anchor TextRoot is exact bytes. */
export function parseGuideAnchorText(
  text: string,
): Result<GuideAnchor, "invalid_anchor"> {
  const parsed = parseInsightArtifactCanonicalJson(
    new TextEncoder().encode(text),
    guideAnchorSchema,
  );
  return parsed._tag === "ok" ? ok(parsed.value) : err("invalid_anchor");
}

const guideReadingStateSchema = v.strictObject({
  result: insightArtifactHashSchema,
  version: insightArtifactUnsignedSchema,
  reviewedGroups: insightArtifactIndexDescriptorSchema,
  expanded: insightArtifactIndexDescriptorSchema,
  anchor: insightTextRootDescriptorSchema,
});
const guideReviewedGroupSchema = v.strictObject({
  groupId: guideGroupIdSchema,
});
const guideExpandedAppearanceSchema = v.strictObject({
  groupId: guideAppearanceGroupSchema,
  fileId: guideFileIdSchema,
});

export const guideReadingStateCodec: InsightArtifactCodec<
  typeof guideReadingStateSchema
> = { name: "GuideReadingState1", schema: guideReadingStateSchema };
export const guideReviewedGroupCodec: InsightArtifactCodec<
  typeof guideReviewedGroupSchema
> = { name: "GuideReviewedGroup1", schema: guideReviewedGroupSchema };
export const guideExpandedAppearanceCodec: InsightArtifactCodec<
  typeof guideExpandedAppearanceSchema
> = { name: "GuideExpandedAppearance1", schema: guideExpandedAppearanceSchema };
export type GuideReadingState = v.InferOutput<typeof guideReadingStateSchema>;

/** App-owned pointer naming the progress root for one exact result digest; it never rewrites an InsightRecord. */
export const guideProgressPointerSchema = v.strictObject({
  format: v.literal(2),
  result: insightArtifactHashSchema,
  version: insightArtifactUnsignedSchema,
  state: insightArtifactReferenceSchema,
});
export type GuideProgressPointer = v.InferOutput<
  typeof guideProgressPointerSchema
>;

const digestSchema = insightArtifactHashSchema;
/** Opaque to the renderer; the server binds the result digest, page kind and position inside it. */
const cursorSchema = v.nullable(
  v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
);
/** Identities are checked by the domain parsers, not by a private length cap of this contract. */
const profileIdSchema = v.pipe(
  v.string(),
  v.check((value) => parseWorkspaceProfileId(value)._tag === "ok"),
);
const reviewIdSchema = v.pipe(
  v.string(),
  v.check((value) => parseReviewId(value)._tag === "ok"),
);

const guidePageSelectorSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("groups"), cursor: cursorSchema }),
  v.strictObject({
    kind: v.literal("members"),
    groupId: guideGroupIdSchema,
    cursor: cursorSchema,
  }),
  v.strictObject({ kind: v.literal("others"), cursor: cursorSchema }),
  v.strictObject({
    kind: v.literal("text"),
    field: v.variant("type", [
      v.strictObject({
        type: v.literal("group_explanation"),
        groupId: guideGroupIdSchema,
      }),
      v.strictObject({
        type: v.literal("captured_patch"),
        fileId: guideFileIdSchema,
      }),
      v.strictObject({
        type: v.literal("inventory_entry"),
        fileId: guideFileIdSchema,
      }),
    ]),
    cursor: cursorSchema,
  }),
  v.strictObject({ kind: v.literal("reviewed"), cursor: cursorSchema }),
  v.strictObject({ kind: v.literal("expanded"), cursor: cursorSchema }),
]);

/** Reads bind the profile, Review and exact result digest; a digest of an older result is stale, never remapped. */
/**
 * The maintainer's explicit Resume acknowledgment. It names the run, the generation and the unresolved dispatch
 * evidence, and states that the responses of those requests are unknown and a new generation will spend again.
 */
const resumeIdentity = {
  profileId: profileIdSchema,
  reviewId: reviewIdSchema,
  runId: v.string(),
  expectedGeneration: insightArtifactUnsignedSchema,
  acknowledgeUnknownSpend: v.literal(true),
};
/** A closed acknowledgment of API request intents or native turn starts, never both. */
export const guideResumeRequestSchema = v.union([
  v.strictObject({
    ...resumeIdentity,
    acknowledgedDispatches: insightArtifactPositiveSchema,
    lastRequestHash: insightArtifactHashSchema,
  }),
  v.strictObject({
    ...resumeIdentity,
    transport: v.literal("native"),
    acknowledgedStarts: insightArtifactPositiveSchema,
    lastStartHash: insightArtifactHashSchema,
  }),
]);

/** The Guide run in progress or resting, as the maintainer needs it after reopening. */
const guideRunSchema = v.nullable(
  v.strictObject({
    runId: v.string(),
    status: v.picklist(["queued", "running", "cancelling", "paused"]),
    generation: insightArtifactUnsignedSchema,
    dispatches: insightArtifactUnsignedSchema,
    /** Set for a paused run: the newest unresolved request a Resume must acknowledge. */
    lastRequestHash: v.nullable(insightArtifactHashSchema),
    native: v.exactOptional(
      v.strictObject({
        transport: v.literal("native"),
        starts: insightArtifactUnsignedSchema,
        lastStartHash: v.nullable(insightArtifactHashSchema),
        cessationConfirmed: v.boolean(),
      }),
    ),
  }),
);
export type GuideRunStatus = v.InferOutput<typeof guideRunSchema>;

export const guideSummaryRequestSchema = v.strictObject({
  profileId: profileIdSchema,
  reviewId: reviewIdSchema,
});
export const guidePageRequestSchema = v.strictObject({
  profileId: profileIdSchema,
  reviewId: reviewIdSchema,
  digest: digestSchema,
  page: guidePageSelectorSchema,
});
export type GuidePageRequest = v.InferOutput<typeof guidePageRequestSchema>;

const progressMutationSchema = v.variant("action", [
  v.strictObject({
    action: v.literal("set_reviewed"),
    groupId: guideGroupIdSchema,
    value: v.boolean(),
  }),
  v.strictObject({
    action: v.literal("set_expanded"),
    groupId: guideAppearanceGroupSchema,
    fileId: guideFileIdSchema,
    value: v.boolean(),
  }),
  v.strictObject({
    action: v.literal("set_anchor"),
    anchor: guideAnchorSchema,
  }),
]);
/** One mark, appearance or anchor per request, under an expected version and the exact result digest. */
export const guideProgressMutationRequestSchema = v.strictObject({
  profileId: profileIdSchema,
  reviewId: reviewIdSchema,
  digest: digestSchema,
  expectedVersion: insightArtifactUnsignedSchema,
  mutation: progressMutationSchema,
});
export type GuideProgressMutationRequest = v.InferOutput<
  typeof guideProgressMutationRequestSchema
>;

const fileSummarySchema = v.strictObject({
  oldPath: v.pipe(v.string(), v.maxLength(1024)),
  newPath: v.pipe(v.string(), v.maxLength(1024)),
  status: v.picklist(["added", "removed", "renamed", "modified"]),
  additions: insightArtifactUnsignedSchema,
  deletions: insightArtifactUnsignedSchema,
  evidence: v.picklist(["text", "binary", "metadata", "omitted", "submodule"]),
});
export type GuideFileSummary = v.InferOutput<typeof fileSummarySchema>;

/** A text value that continues across pages when it does not fit one reply. */
const textPartSchema = v.strictObject({
  text: v.string(),
  next: cursorSchema,
});

const completenessSchema = v.strictObject({
  knownOmittedChecks: insightArtifactUnsignedSchema,
  knownOmittedThreads: insightArtifactUnsignedSchema,
  knownOmittedRules: insightArtifactUnsignedSchema,
  upstreamCompleteness: v.picklist(["complete", "partial", "unknown"]),
});

// Failure metadata is independent of any retained result or legacy Guide value.
const guideFailureSchema = v.nullable(
  v.strictObject({
    runId: v.string(),
    reason: v.picklist(["cancelled", "failed", "invalid_result", "superseded"]),
    category: v.nullable(v.picklist(INSIGHT_FAILURE_CATEGORIES)),
    retryable: v.boolean(),
  }),
);

/** Bounded result metadata and current terminal failure; no patch, inventory or group text. */
export const guideSummarySchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("none"),
    run: guideRunSchema,
    failure: guideFailureSchema,
  }),
  v.strictObject({
    _tag: v.literal("ready"),
    run: guideRunSchema,
    failure: guideFailureSchema,
    runId: v.string(),
    sessionId: v.string(),
    revision: v.strictObject({
      baseSha: insightArtifactGitShaSchema,
      headSha: insightArtifactGitShaSchema,
      patchHash: insightArtifactHashSchema,
    }),
    digest: digestSchema,
    groups: insightArtifactUnsignedSchema,
    inventory: insightArtifactUnsignedSchema,
    others: insightArtifactUnsignedSchema,
    completeness: completenessSchema,
    progressVersion: insightArtifactUnsignedSchema,
    anchor: guideAnchorSchema,
  }),
]);
export type GuideSummary = v.InferOutput<typeof guideSummarySchema>;

export const guidePageSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("groups"),
    items: v.array(
      v.strictObject({
        id: guideGroupIdSchema,
        title: v.string(),
        memberCount: insightArtifactUnsignedSchema,
        explanation: textPartSchema,
      }),
    ),
    next: cursorSchema,
  }),
  v.strictObject({
    kind: v.literal("members"),
    groupId: guideGroupIdSchema,
    items: v.array(
      v.strictObject({
        fileId: guideFileIdSchema,
        relevance: textPartSchema,
        file: v.nullable(fileSummarySchema),
      }),
    ),
    next: cursorSchema,
  }),
  v.strictObject({
    kind: v.literal("others"),
    items: v.array(
      v.strictObject({
        fileId: guideFileIdSchema,
        file: v.nullable(fileSummarySchema),
      }),
    ),
    next: cursorSchema,
  }),
  v.strictObject({ kind: v.literal("text"), part: textPartSchema }),
  v.strictObject({
    kind: v.literal("reviewed"),
    groups: v.array(guideGroupIdSchema),
    next: cursorSchema,
  }),
  v.strictObject({
    kind: v.literal("expanded"),
    appearances: v.array(guideExpandedAppearanceSchema),
    next: cursorSchema,
  }),
]);
export type GuidePage = v.InferOutput<typeof guidePageSchema>;

/** Why a bounded read or progress save was refused. */
const GUIDE_READ_FAILURES = [
  "not_available",
  "stale_result",
  "invalid_cursor",
  "invalid_result",
  "invalid_progress",
  "version_conflict",
  "storage_unavailable",
] as const;
export type GuideReadFailure = (typeof GUIDE_READ_FAILURES)[number];
