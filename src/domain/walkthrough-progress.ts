import * as v from "valibot";

import type { InsightArtifactCodec } from "./insight-artifact-index";
import {
  insightArtifactHashSchema as Hash,
  insightArtifactUnsignedSchema as U,
  insightArtifactIndexDescriptorSchema as I,
  insightArtifactReferenceSchema as R,
} from "./insight-artifact-scalars";
import {
  guideSummarySchema,
  guideSummaryRequestSchema,
} from "./guide-progress";
import {
  walkthroughSectionIdSchema as SectionId,
  walkthroughChapterIdSchema as ChapterId,
} from "./walkthrough-protocol";
import { walkthroughHunkIdSchema as HunkId } from "./walkthrough-preparation";

const cursor = v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(512)));
const scope = guideSummaryRequestSchema.entries;
const metadata = guideSummarySchema.options[1].entries;

/** A digest-bound selector, with no storage paths or object references supplied by the caller. */
const walkthroughPageSelectorSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("navigation"), cursor }),
  v.strictObject({ kind: v.literal("section"), sectionId: SectionId }),
  v.strictObject({
    kind: v.literal("citations"),
    sectionId: SectionId,
    cursor,
  }),
  v.strictObject({ kind: v.literal("uncited"), cursor }),
  v.strictObject({
    kind: v.literal("hunk_text"),
    sectionId: v.nullable(SectionId),
    hunkId: HunkId,
    field: v.picklist(["raw", "filePrefix", "header", "path"]),
    cursor,
  }),
]);
/** Summary requires only the owning Review. */
export const walkthroughSummaryRequestSchema = v.strictObject(scope);
/** Pages always bind the exact published digest. */
export const walkthroughPageRequestSchema = v.strictObject({
  ...scope,
  digest: Hash,
  page: walkthroughPageSelectorSchema,
});
/** Parsed page request. */
export type WalkthroughPageRequest = v.InferOutput<
  typeof walkthroughPageRequestSchema
>;

const mutation = v.variant("action", [
  v.strictObject({
    action: v.literal("set_reviewed"),
    sectionId: SectionId,
    value: v.boolean(),
  }),
  v.strictObject({ action: v.literal("set_current"), sectionId: SectionId }),
]);
/** One optimistic progress intent, fenced by result and version. */
const walkthroughProgressMutationRequestSchema = v.strictObject({
  ...scope,
  digest: Hash,
  expectedVersion: U,
  mutation,
});
/** Parsed progress intent. */
export type WalkthroughProgressMutationRequest = v.InferOutput<
  typeof walkthroughProgressMutationRequestSchema
>;
const readingState = v.strictObject({
  result: Hash,
  version: U,
  reviewedSections: I,
  currentSectionId: v.nullable(SectionId),
});
const reviewedSection = v.strictObject({ sectionId: SectionId });
/** Immutable reading state for one result, separate from legacy records. */
export const walkthroughReadingStateCodec: InsightArtifactCodec<
  typeof readingState
> = { name: "WalkthroughReadingState1", schema: readingState };
/** One reviewed section, indexed in section order. */
export const walkthroughReviewedSectionCodec: InsightArtifactCodec<
  typeof reviewedSection
> = { name: "WalkthroughReviewedSection1", schema: reviewedSection };
/** Parsed retained reading state. */
export type WalkthroughReadingState = v.InferOutput<typeof readingState>;
/** Canonical compare-and-replace pointer. */
export const walkthroughProgressPointerSchema = v.strictObject({
  format: v.literal(2),
  result: Hash,
  version: U,
  state: R,
});

/** Bounded metadata, counts and progress. It contains no result arrays or captured patch. */
const walkthroughSummarySchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("none"),
    run: metadata.run,
    failure: metadata.failure,
  }),
  v.strictObject({
    _tag: v.literal("ready"),
    run: metadata.run,
    failure: metadata.failure,
    runId: v.string(),
    sessionId: v.string(),
    revision: metadata.revision,
    digest: Hash,
    generatedAt: v.string(),
    provenance: v.strictObject({
      provider: v.literal("pi"),
      model: v.string(),
      language: v.picklist(["en", "vi"]),
    }),
    title: v.string(),
    focus: v.string(),
    chapters: U,
    sections: U,
    hunks: U,
    citedHunks: U,
    uncited: U,
    completeness: metadata.completeness,
    progressVersion: U,
    currentSectionId: v.nullable(SectionId),
    reviewedCount: U,
  }),
]);
/** Parsed summary used by all consumers. */
export type WalkthroughSummary = v.InferOutput<typeof walkthroughSummarySchema>;
const chapter = v.strictObject({ id: ChapterId, title: v.string() });
const citation = v.strictObject({
  hunkId: HunkId,
  path: v.strictObject({ text: v.string(), next: cursor }),
  oldStart: U,
  oldLines: U,
  newStart: U,
  newLines: U,
});
/** One bounded page. Hunk text continues without losing original coordinates. */
const walkthroughPageSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("navigation"),
    items: v.array(
      v.strictObject({
        sectionId: SectionId,
        ordinal: U,
        title: v.string(),
        chapter,
        reviewed: v.boolean(),
      }),
    ),
    next: cursor,
  }),
  v.strictObject({
    kind: v.literal("section"),
    sectionId: SectionId,
    ordinal: U,
    title: v.string(),
    prose: v.string(),
    chapter,
    citationCount: U,
    previous: v.nullable(SectionId),
    next: v.nullable(SectionId),
    reviewed: v.boolean(),
  }),
  v.strictObject({
    kind: v.literal("citations"),
    sectionId: SectionId,
    items: v.array(citation),
    next: cursor,
  }),
  v.strictObject({
    kind: v.literal("uncited"),
    items: v.array(citation),
    next: cursor,
  }),
  v.strictObject({
    kind: v.literal("hunk_text"),
    text: v.string(),
    next: cursor,
  }),
]);
/** Parsed page reply. */
export type WalkthroughPage = v.InferOutput<typeof walkthroughPageSchema>;
/** Failure categories shared by bounded reads and fenced progress writes. */
export type WalkthroughReadFailure =
  | "not_available"
  | "stale_result"
  | "invalid_cursor"
  | "invalid_result"
  | "invalid_progress"
  | "version_conflict"
  | "storage_unavailable";
