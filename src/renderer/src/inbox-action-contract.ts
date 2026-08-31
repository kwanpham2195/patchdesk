import * as v from "valibot";

/** Strict optional renderer wire shape for a fresh read-only merge-readiness action. */
export const inboxMergeReadinessActionSchema = v.strictObject({
  kind: v.literal("open_merge_readiness"),
  label: v.literal("Open merge readiness"),
  reviewId: v.pipe(v.string(), v.minLength(1)),
});

/** Strict renderer wire-boundary schema for a row's one recommended action. */
export const inboxRecommendedActionSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("run_review"),
    label: v.literal("Run review"),
  }),
  v.strictObject({
    kind: v.literal("open_merged_review"),
    label: v.literal("View merged pull request"),
  }),
  v.strictObject({
    kind: v.literal("open_saved_review"),
    label: v.literal("Open Review"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
  }),
  inboxMergeReadinessActionSchema,
]);
