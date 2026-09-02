import * as v from "valibot";

/** Strict renderer wire-boundary schema for a row's one recommended action. */
export const inboxRecommendedActionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("run_review") }),
  v.strictObject({ kind: v.literal("open_merged_review") }),
  v.strictObject({
    kind: v.literal("open_saved_review"),
    reviewId: v.pipe(v.string(), v.minLength(1)),
  }),
]);
