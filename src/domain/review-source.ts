import * as v from "valibot";

import {
  parseGitSha,
  parseLocalBranchName,
  type GitSha,
  type GitShaPrefix,
  type LocalBranchName,
  type PullRequestNumber,
} from "./ids";
import { casesHandled, err, ok, type Result } from "./result";

/** A GitHub pull request, compared base...head as GitHub reports it. */
export type PullRequestReviewSource = {
  readonly kind: "pull_request";
  readonly prNumber: PullRequestNumber;
};

/**
 * The maintainer's checkout against `HEAD`. `branch` is the branch `HEAD`
 * names and is absent when `HEAD` is detached, so a branch switch opens a
 * different Review (ADR 0050).
 */
type WorkingTreeReviewSource = {
  readonly kind: "working_tree";
  readonly branch?: LocalBranchName;
};

/** A local branch against its merge base with a chosen local base branch. */
type BranchReviewSource = {
  readonly kind: "branch";
  readonly branch: LocalBranchName;
  readonly baseBranch: LocalBranchName;
};

/** One commit against its first parent, or the empty tree for a root commit. */
type CommitReviewSource = {
  readonly kind: "commit";
  readonly commitSha: GitSha;
};

/** A Review source read from a profile repository's `localPath`, never fetched. */
export type LocalReviewSource =
  | WorkingTreeReviewSource
  | BranchReviewSource
  | CommitReviewSource;

/** What a Review's patch is computed from (ADR 0050, CONTEXT.md "Review source"). */
export type ReviewSource = PullRequestReviewSource | LocalReviewSource;

/**
 * The local source a maintainer asks to open. A working tree names no branch:
 * the branch is read from `HEAD` when the checkout is read, and a commit may
 * be abbreviated until git resolves it.
 */
export type LocalReviewSourceRequest =
  | {
      readonly kind: "working_tree";
      /** Set when reopening a stored working-tree Review, so a branch switch refuses instead of opening another Review. */
      readonly expectedHead?: ExpectedWorkingTreeHead;
    }
  | {
      readonly kind: "branch";
      readonly branch: LocalBranchName;
      readonly baseBranch: LocalBranchName;
    }
  | { readonly kind: "commit"; readonly commit: GitShaPrefix };

/** The `HEAD` a working-tree open expects: a named branch, or detached. */
type ExpectedWorkingTreeHead =
  | { readonly kind: "branch"; readonly branch: LocalBranchName }
  | { readonly kind: "detached" };

/** True when both values name the same source spec, so they key the same Review. */
export function sameReviewSource(
  left: ReviewSource,
  right: ReviewSource,
): boolean {
  switch (left.kind) {
    case "pull_request":
      return right.kind === "pull_request" && left.prNumber === right.prNumber;
    case "working_tree":
      return right.kind === "working_tree" && left.branch === right.branch;
    case "branch":
      return (
        right.kind === "branch" &&
        left.branch === right.branch &&
        left.baseBranch === right.baseBranch
      );
    case "commit":
      return right.kind === "commit" && left.commitSha === right.commitSha;
    default:
      return casesHandled(left);
  }
}

/**
 * The stored form of a local source. Pull request records carry `prNumber`
 * flat instead, in the shape they had before local sources existed.
 */
export const storedLocalReviewSourceSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("working_tree"),
    branch: v.optional(v.string()),
  }),
  v.strictObject({
    kind: v.literal("branch"),
    branch: v.string(),
    baseBranch: v.string(),
  }),
  v.strictObject({ kind: v.literal("commit"), commitSha: v.string() }),
]);

type StoredLocalReviewSource = v.InferOutput<
  typeof storedLocalReviewSourceSchema
>;

/** Refine a schema-checked stored local source into branded values. */
export function parseStoredLocalReviewSource(
  raw: StoredLocalReviewSource,
): Result<LocalReviewSource, { readonly _tag: "InvalidReviewSource" }> {
  switch (raw.kind) {
    case "working_tree": {
      if (raw.branch === undefined) return ok({ kind: "working_tree" });
      const branch = parseLocalBranchName(raw.branch);
      return branch._tag === "ok"
        ? ok({ kind: "working_tree", branch: branch.value })
        : invalidSource();
    }
    case "branch": {
      const branch = parseLocalBranchName(raw.branch);
      const baseBranch = parseLocalBranchName(raw.baseBranch);
      return branch._tag === "ok" && baseBranch._tag === "ok"
        ? ok({
            kind: "branch",
            branch: branch.value,
            baseBranch: baseBranch.value,
          })
        : invalidSource();
    }
    case "commit": {
      const commitSha = parseGitSha(raw.commitSha);
      return commitSha._tag === "ok"
        ? ok({ kind: "commit", commitSha: commitSha.value })
        : invalidSource();
    }
    default:
      return casesHandled(raw);
  }
}

function invalidSource(): Result<
  never,
  { readonly _tag: "InvalidReviewSource" }
> {
  return err({ _tag: "InvalidReviewSource" });
}
