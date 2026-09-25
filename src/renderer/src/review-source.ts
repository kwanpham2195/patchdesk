import * as v from "valibot";

import { casesHandled } from "../../domain/result";

/** What a Review's patch is computed from; every kind but `pull_request` is a local Review (ADR 0050). */
export const reviewSourceSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("pull_request"),
    prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.strictObject({
    kind: v.literal("working_tree"),
    branch: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    kind: v.literal("branch"),
    branch: v.pipe(v.string(), v.minLength(1)),
    baseBranch: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    kind: v.literal("commit"),
    commitSha: v.pipe(v.string(), v.minLength(7)),
  }),
]);

export type WorkbenchReviewSource = v.InferOutput<typeof reviewSourceSchema>;

/** The pull request number a Review represents; absent for a local Review. */
export function workbenchPullRequestNumber(
  source: WorkbenchReviewSource,
): number | undefined {
  return source.kind === "pull_request" ? source.prNumber : undefined;
}

/** The heading a Review shows when GitHub supplied no pull request title. */
export function reviewSourceTitle(source: WorkbenchReviewSource): string {
  switch (source.kind) {
    case "pull_request":
      return `Pull request #${source.prNumber}`;
    case "working_tree":
      return `Working tree on ${source.branch ?? "detached HEAD"}`;
    case "branch":
      return `Branch ${source.branch} against ${source.baseBranch}`;
    case "commit":
      return `Commit ${source.commitSha.slice(0, 8)}`;
    default:
      return casesHandled(source);
  }
}
