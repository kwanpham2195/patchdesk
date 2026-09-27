import * as v from "valibot";

import type { LocalPatchView } from "../../domain/local-patch-view";
import { casesHandled } from "../../domain/result";

/** What the view control and the header call each patch view of a shared local Review. */
export const localPatchViewLabels = {
  combined: "Combined",
  committed: "Committed",
  uncommitted: "Uncommitted",
} as const satisfies Record<LocalPatchView, string>;

/** A local Review source (ADR 0050), as the workbench carries it. */
const localReviewSourceSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("working_tree"),
    branch: v.optional(v.pipe(v.string(), v.minLength(1))),
    checkout: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    kind: v.literal("branch"),
    branch: v.pipe(v.string(), v.minLength(1)),
    baseBranch: v.pipe(v.string(), v.minLength(1)),
    checkout: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    kind: v.literal("local_branch"),
    branch: v.pipe(v.string(), v.minLength(1)),
    baseBranch: v.pipe(v.string(), v.minLength(1)),
    checkout: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    kind: v.literal("commit"),
    commitSha: v.pipe(v.string(), v.minLength(7)),
    checkout: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
]);

/** What a Review's patch is computed from; every kind but `pull_request` is a local Review (ADR 0050). */
export const reviewSourceSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("pull_request"),
    prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  ...localReviewSourceSchema.options,
]);

export type WorkbenchReviewSource = v.InferOutput<typeof reviewSourceSchema>;

/** The pull request number a Review represents; absent for a local Review. */
export function workbenchPullRequestNumber(
  source: WorkbenchReviewSource,
): number | undefined {
  return source.kind === "pull_request" ? source.prNumber : undefined;
}

/**
 * What a local Review's header says about its revision: the commit it
 * represents, the patch view shown on a shared Review, and that it was read
 * from the checkout. It names no GitHub state because a local Review has none;
 * absent for a pull request.
 */
export function localRevisionLabel(
  source: WorkbenchReviewSource,
  headSha: string,
  view: LocalPatchView = "combined",
): string | undefined {
  const short = headSha.slice(0, 8);
  switch (source.kind) {
    case "pull_request":
      return undefined;
    case "working_tree":
      return `Local snapshot ${short} · read from the local checkout`;
    case "branch":
      return `Branch tip ${short} · read from the local checkout`;
    case "local_branch":
      return `${localPatchViewLabels[view]} view · Local snapshot ${short} · ${source.branch === "detached" ? "detached HEAD" : source.branch} against ${source.baseBranch} · read from the local checkout`;
    case "commit":
      return `Commit ${short} · read from the local checkout`;
    default:
      return casesHandled(source);
  }
}
