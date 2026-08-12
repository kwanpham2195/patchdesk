import type { AbsolutePath } from "./ids";

declare const representedReviewWorktreeBrand: unique symbol;

/** An app-verified immutable worktree for the current represented Review revision. */
export type RepresentedReviewWorktree = AbsolutePath & {
  readonly [representedReviewWorktreeBrand]: "RepresentedReviewWorktree";
};
