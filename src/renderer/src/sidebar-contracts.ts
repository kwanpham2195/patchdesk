import * as v from "valibot";

import { localReviewSourceSchema } from "./review-source";

const sidebarPullRequestRowSchema = v.strictObject({
  reviewId: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  // Absent on a Review opened before the route stored a title.
  title: v.optional(v.pipe(v.string(), v.minLength(1))),
  // What the column orders and date-groups by, present on every row.
  sortedAt: v.pipe(v.string(), v.minLength(1)),
  // Absent on a Review stored before Patchdesk recorded opens. The row's
  // age comes from this alone, so an unvisited row shows none.
  lastOpenedAt: v.optional(v.pipe(v.string(), v.minLength(1))),
  // Absent while the pull request is still open. `observedAt` is when
  // Patchdesk saw the state — except on the recovery path, which dates a
  // merge from GitHub's own `mergedAt` — so the row can date what it shows.
  terminal: v.optional(
    v.strictObject({
      state: v.picklist(["merged", "closed"]),
      observedAt: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
});

// A local Review (ADR 0050). The row is named from `source`, and `host` is
// what the local open route needs to reopen it.
const sidebarLocalReviewRowSchema = v.strictObject({
  reviewId: v.pipe(v.string(), v.minLength(1)),
  host: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  source: localReviewSourceSchema,
  sortedAt: v.pipe(v.string(), v.minLength(1)),
  lastOpenedAt: v.optional(v.pipe(v.string(), v.minLength(1))),
});

// `GET /v1/sidebar/reviews` is a local-API payload Patchdesk owns on both
// sides (ADR "Choose a validation style by data boundary"), so it gets a
// `v.strictObject` parsed with `v.safeParse`.
export const sidebarReviewsResponseSchema = v.strictObject({
  rows: v.array(
    v.union([sidebarPullRequestRowSchema, sidebarLocalReviewRowSchema]),
  ),
  // How many stored Reviews the route could not read. A diagnostic the main
  // process already recorded; the column draws nothing for it.
  unreadable: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type SidebarReviewsResponse = v.InferOutput<
  typeof sidebarReviewsResponseSchema
>;
export type SidebarReviewRow = SidebarReviewsResponse["rows"][number];
export type SidebarPullRequestRow = v.InferOutput<
  typeof sidebarPullRequestRowSchema
>;
export type SidebarLocalReviewRow = v.InferOutput<
  typeof sidebarLocalReviewRowSchema
>;

/** Narrows a sidebar row to a local Review, which has a source spec and no pull request number. */
export function isSidebarLocalReviewRow(
  row: SidebarReviewRow,
): row is SidebarLocalReviewRow {
  return "source" in row;
}
