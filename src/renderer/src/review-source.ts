import * as v from "valibot";

import { baseRefName } from "#src/domain/ids";
import type { LocalPatchView } from "#src/domain/local-patch-view";
import { casesHandled } from "#src/domain/result";

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
    baseRef: v.pipe(v.string(), v.minLength(1)),
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

/** Whether the navigator has a Commits section; a `commit` or pre-#555 local Review has no branch history to list (#557 D4). */
export function sourceListsCommits(source: WorkbenchReviewSource): boolean {
  return source.kind === "pull_request" || source.kind === "local_branch";
}

/**
 * What a local Review's header says about its revision: the commit it
 * represents, the patch view shown on a shared Review, and that it was read
 * from the checkout, or that the checkout is gone and the Review is its captured
 * snapshot. It names no GitHub state because a local Review has none;
 * absent for a pull request.
 */
export function localRevisionLabel(
  source: WorkbenchReviewSource,
  headSha: string,
  view: LocalPatchView = "combined",
  checkoutMissing = false,
): string | undefined {
  const short = headSha.slice(0, 8);
  const origin = checkoutMissing
    ? "checkout folder missing"
    : "read from the local checkout";
  switch (source.kind) {
    case "pull_request":
      return undefined;
    case "working_tree":
      return `Local snapshot ${short} · ${origin}`;
    case "branch":
      return `Branch tip ${short} · ${origin}`;
    case "local_branch":
      return `${localPatchViewLabels[view]} view · Local snapshot ${short} · ${source.branch === "detached" ? "detached HEAD" : source.branch} against ${baseRefName(source.baseRef)} · ${origin}`;
    case "commit":
      return `Commit ${short} · ${origin}`;
    default:
      return casesHandled(source);
  }
}
