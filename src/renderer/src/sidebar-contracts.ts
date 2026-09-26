import * as v from "valibot";

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

// One repository's local Reviews (#479). `host` is what the local open route
// needs, and `reviewIds` names every local Review the row stands for.
const sidebarLocalRepositoryRowSchema = v.strictObject({
  host: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  reviewIds: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1))),
    v.minLength(1),
  ),
  sortedAt: v.pipe(v.string(), v.minLength(1)),
  lastOpenedAt: v.optional(v.pipe(v.string(), v.minLength(1))),
});

// `GET /v1/sidebar/reviews` is a local-API payload Patchdesk owns on both
// sides (ADR "Choose a validation style by data boundary"), so it gets a
// `v.strictObject` parsed with `v.safeParse`.
export const sidebarReviewsResponseSchema = v.strictObject({
  rows: v.array(
    v.union([sidebarPullRequestRowSchema, sidebarLocalRepositoryRowSchema]),
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
export type SidebarLocalRepositoryRow = v.InferOutput<
  typeof sidebarLocalRepositoryRowSchema
>;

/** Narrows a sidebar row to a repository's local row, which has no pull request number. */
export function isSidebarLocalRepositoryRow(
  row: SidebarReviewRow,
): row is SidebarLocalRepositoryRow {
  return "reviewIds" in row;
}

/** A key unique among the listed rows: a pull request row's Review id, or a local row's repository. */
export function sidebarRowKey(row: SidebarReviewRow): string {
  return isSidebarLocalRepositoryRow(row)
    ? `local:${row.host}/${row.owner}/${row.repo}`
    : row.reviewId;
}

/** Whether the row stands for the open Review; a local row covers each of its repository's local Reviews. */
export function sidebarRowShowsReview(
  row: SidebarReviewRow,
  reviewId: string | undefined,
): boolean {
  if (reviewId === undefined) return false;
  return isSidebarLocalRepositoryRow(row)
    ? row.reviewIds.includes(reviewId)
    : row.reviewId === reviewId;
}
