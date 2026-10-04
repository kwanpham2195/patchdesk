import * as v from "valibot";

import { definedProps } from "./defined-props";
import {
  baseRefName,
  checkoutFolderName,
  detachedHeadBranch,
  parseAbsolutePath,
  parseGitSha,
  parseGitShaPrefix,
  parseLocalBaseRef,
  parseLocalBranchName,
  type AbsolutePath,
  type GitSha,
  type GitShaPrefix,
  type LocalBaseRef,
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
 * The maintainer's checkout against `HEAD`, stored before the shared Review
 * (#555). Records still parse; nothing opens one again. `branch` is absent
 * when `HEAD` was detached.
 */
type WorkingTreeReviewSource = LocalCheckout & {
  readonly kind: "working_tree";
  readonly branch?: LocalBranchName;
};

/** A local branch tip against its merge base with a base branch, stored before the shared Review (#555); records still parse. */
type BranchReviewSource = LocalCheckout & {
  readonly kind: "branch";
  readonly branch: LocalBranchName;
  readonly baseBranch: LocalBranchName;
};

/**
 * The shared local Review (#555, ADR 0050): the checkout's Local snapshot
 * against its merge base with `baseRef`, a local or remote-tracking branch
 * (#591), so committed and uncommitted work on `branch` is one diff with one
 * draft list. `branch` is the branch `HEAD` names, `detachedHeadBranch` when
 * it is detached, so a branch switch keys another Review.
 */
type LocalBranchReviewSource = LocalCheckout & {
  readonly kind: "local_branch";
  readonly branch: LocalBranchName;
  readonly baseRef: LocalBaseRef;
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
  | LocalBranchReviewSource
  | CommitReviewSource;

/** What a Review's patch is computed from (ADR 0050, docs/product-description/glossary.md "Review source"). */
export type ReviewSource = PullRequestReviewSource | LocalReviewSource;

/**
 * The local source a maintainer asks to open. A shared Review names only its
 * base: the branch is read from `HEAD` when the checkout is read. A commit may
 * be abbreviated until git resolves it. Working-tree and branch sources are
 * no longer opened (#555).
 */
export type LocalReviewSourceRequest = LocalCheckout &
  (
    | {
        readonly kind: "local_branch";
        readonly baseRef: LocalBaseRef;
        /** The branch the Review names; a checkout on another branch is refused instead of opening that branch's Review. */
        readonly expectedHead?: ExpectedCheckoutHead;
      }
    | { readonly kind: "commit"; readonly commit: GitShaPrefix }
  );

/** The `HEAD` an open expects: a named branch, or detached. */
type ExpectedCheckoutHead =
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
    case "local_branch":
      return (
        right.kind === "local_branch" &&
        left.branch === right.branch &&
        left.baseRef === right.baseRef &&
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
    kind: v.literal("local_branch"),
    branch: v.string(),
    baseRef: v.string(),
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
    case "local_branch": {
      const branch = parseLocalBranchName(raw.branch);
      const baseRef = parseLocalBaseRef(raw.baseRef);
      return branch._tag === "ok" && baseRef._tag === "ok"
        ? ok({
            kind: "local_branch",
            branch: branch.value,
            baseRef: baseRef.value,
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

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const expectedHeadSchema = v.optional(
  v.variant("kind", [
    v.strictObject({ kind: v.literal("branch"), branch: nonEmpty }),
    v.strictObject({ kind: v.literal("detached") }),
  ]),
);

/** The wire form of the local source a maintainer asks to open; `parseLocalReviewSourceRequest` applies the name, SHA, and path rules. */
export const localReviewSourceRequestSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("local_branch"),
    baseRef: nonEmpty,
    expectedHead: expectedHeadSchema,
    checkout: v.optional(nonEmpty),
  }),
  v.strictObject({
    kind: v.literal("commit"),
    commit: nonEmpty,
    checkout: v.optional(nonEmpty),
  }),
]);

type LocalReviewSourceRequestInput = v.InferOutput<
  typeof localReviewSourceRequestSchema
>;

/** The source request with its checkout, which must be an absolute path (#489). */
export function parseLocalReviewSourceRequest(
  raw: LocalReviewSourceRequestInput,
): LocalReviewSourceRequest | undefined {
  const spec = parseSourceRequestSpec(raw);
  if (spec === undefined || raw.checkout === undefined) return spec;
  const checkout = parseAbsolutePath(raw.checkout);
  return checkout._tag === "ok"
    ? { ...spec, checkout: checkout.value }
    : undefined;
}

function parseSourceRequestSpec(
  raw: LocalReviewSourceRequestInput,
): LocalReviewSourceRequest | undefined {
  if (raw.kind === "local_branch") {
    const baseRef = parseLocalBaseRef(raw.baseRef);
    const expected = parseExpectedHead(raw.expectedHead);
    return baseRef._tag === "err" || expected === undefined
      ? undefined
      : {
          kind: "local_branch",
          baseRef: baseRef.value,
          ...definedProps({ expectedHead: expected.head }),
        };
  }
  const commit = parseGitShaPrefix(raw.commit.toLowerCase());
  return commit._tag === "ok"
    ? { kind: "commit", commit: commit.value }
    : undefined;
}

/** `{}` when no `HEAD` is expected, `{ head }` for a valid one, undefined for a branch name git would refuse. */
function parseExpectedHead(
  raw: v.InferOutput<typeof expectedHeadSchema>,
): { readonly head?: ExpectedCheckoutHead } | undefined {
  if (raw === undefined) return {};
  if (raw.kind === "detached") return { head: { kind: "detached" } };
  const branch = parseLocalBranchName(raw.branch);
  return branch._tag === "ok"
    ? { head: { kind: "branch", branch: branch.value } }
    : undefined;
}

/**
 * The request that reads a stored local source from the checkout again. A
 * shared Review names the branch it was opened on, so a branch switch is
 * refused rather than read as this Review. The request names the Review's
 * checkout, so it is read from that same checkout. Undefined for a stored
 * commit SHA that is not a valid prefix, and for a working-tree or branch
 * Review stored before the shared Review (#555), which nothing reads again.
 */
export function reopenLocalSourceRequest(
  source: LocalReviewSource,
): LocalReviewSourceRequest | undefined {
  switch (source.kind) {
    case "working_tree":
    case "branch":
      return undefined;
    case "local_branch":
      return {
        kind: "local_branch",
        baseRef: source.baseRef,
        expectedHead:
          source.branch === detachedHeadBranch
            ? { kind: "detached" }
            : { kind: "branch", branch: source.branch },
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
      readonly kind: "local_branch";
      readonly branch: string;
      readonly baseRef: string;
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
    case "local_branch":
      return `${source.branch === detachedHeadBranch ? "Detached HEAD" : source.branch} against ${baseRefName(source.baseRef)}${checkoutSuffix(source.checkout)}`;
    case "commit":
      return `Commit ${source.commitSha.slice(0, 8)}${checkoutSuffix(source.checkout)}`;
    default:
      return casesHandled(source);
  }
}

function checkoutSuffix(checkout: string | undefined): string {
  return checkout === undefined ? "" : ` in ${checkoutFolderName(checkout)}`;
}
