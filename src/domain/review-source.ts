import * as v from "valibot";

import { definedProps } from "./defined-props";
import {
  parseAbsolutePath,
  parseGitSha,
  parseGitShaPrefix,
  parseLocalBranchName,
  type AbsolutePath,
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
 * The checkout a local source is read from, when it is not the profile's
 * configured `localPath`: the resolved top-level of a linked worktree of the
 * same repository. Absent means the configured checkout (ADR 0050 "Identity").
 */
type LocalCheckout = { readonly checkout?: AbsolutePath };

/**
 * The maintainer's checkout against `HEAD`. `branch` is the branch `HEAD`
 * names and is absent when `HEAD` is detached, so a branch switch opens a
 * different Review (ADR 0050).
 */
type WorkingTreeReviewSource = LocalCheckout & {
  readonly kind: "working_tree";
  readonly branch?: LocalBranchName;
};

/** A local branch against its merge base with a chosen local base branch. */
type BranchReviewSource = LocalCheckout & {
  readonly kind: "branch";
  readonly branch: LocalBranchName;
  readonly baseBranch: LocalBranchName;
};

/** One commit against its first parent, or the empty tree for a root commit. */
type CommitReviewSource = LocalCheckout & {
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
export type LocalReviewSourceRequest = LocalCheckout &
  (
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
    | { readonly kind: "commit"; readonly commit: GitShaPrefix }
  );

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
      return (
        right.kind === "working_tree" &&
        left.branch === right.branch &&
        left.checkout === right.checkout
      );
    case "branch":
      return (
        right.kind === "branch" &&
        left.branch === right.branch &&
        left.baseBranch === right.baseBranch &&
        left.checkout === right.checkout
      );
    case "commit":
      return (
        right.kind === "commit" &&
        left.commitSha === right.commitSha &&
        left.checkout === right.checkout
      );
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
    checkout: v.optional(v.string()),
  }),
  v.strictObject({
    kind: v.literal("branch"),
    branch: v.string(),
    baseBranch: v.string(),
    checkout: v.optional(v.string()),
  }),
  v.strictObject({
    kind: v.literal("commit"),
    commitSha: v.string(),
    checkout: v.optional(v.string()),
  }),
]);

type StoredLocalReviewSource = v.InferOutput<
  typeof storedLocalReviewSourceSchema
>;

/** Refine a schema-checked stored local source into branded values. */
export function parseStoredLocalReviewSource(
  raw: StoredLocalReviewSource,
): Result<LocalReviewSource, { readonly _tag: "InvalidReviewSource" }> {
  if (raw.checkout === undefined) return parseStoredSourceSpec(raw);
  const checkout = parseAbsolutePath(raw.checkout);
  const source = parseStoredSourceSpec(raw);
  if (checkout._tag === "err" || source._tag === "err") return invalidSource();
  return ok({ ...source.value, checkout: checkout.value });
}

function parseStoredSourceSpec(
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

/**
 * The request that reads a stored local source from the checkout again. A
 * working tree names the `HEAD` it was opened on, so a branch switch is
 * refused rather than read as this Review. The request names the Review's
 * checkout, so it is read from that same checkout. Undefined only for a stored
 * commit SHA that is not a valid prefix.
 */
export function reopenLocalSourceRequest(
  source: LocalReviewSource,
): LocalReviewSourceRequest | undefined {
  switch (source.kind) {
    case "working_tree":
      return {
        kind: "working_tree",
        expectedHead:
          source.branch === undefined
            ? { kind: "detached" }
            : { kind: "branch", branch: source.branch },
        ...definedProps({ checkout: source.checkout }),
      };
    case "branch":
      return {
        kind: "branch",
        branch: source.branch,
        baseBranch: source.baseBranch,
        ...definedProps({ checkout: source.checkout }),
      };
    case "commit": {
      const commit = parseGitShaPrefix(source.commitSha);
      return commit._tag === "ok"
        ? {
            kind: "commit",
            commit: commit.value,
            ...definedProps({ checkout: source.checkout }),
          }
        : undefined;
    }
    default:
      return casesHandled(source);
  }
}

/** A Review source as plain strings: the domain source, or the renderer's parsed copy of it. */
type ReviewSourceText =
  | { readonly kind: "pull_request"; readonly prNumber: number }
  | {
      readonly kind: "working_tree";
      readonly branch?: string | undefined;
      readonly checkout?: string | undefined;
    }
  | {
      readonly kind: "branch";
      readonly branch: string;
      readonly baseBranch: string;
      readonly checkout?: string | undefined;
    }
  | {
      readonly kind: "commit";
      readonly commitSha: string;
      readonly checkout?: string | undefined;
    };

/** The heading a Review shows when GitHub supplied no pull request title; a named checkout adds its folder. */
export function reviewSourceTitle(source: ReviewSourceText): string {
  switch (source.kind) {
    case "pull_request":
      return `Pull request #${source.prNumber}`;
    case "working_tree":
      return `Working tree on ${source.branch ?? "detached HEAD"}${checkoutSuffix(source.checkout)}`;
    case "branch":
      return `Branch ${source.branch} against ${source.baseBranch}${checkoutSuffix(source.checkout)}`;
    case "commit":
      return `Commit ${source.commitSha.slice(0, 8)}${checkoutSuffix(source.checkout)}`;
    default:
      return casesHandled(source);
  }
}

function checkoutSuffix(checkout: string | undefined): string {
  return checkout === undefined
    ? ""
    : ` in ${checkout.slice(checkout.lastIndexOf("/") + 1)}`;
}
