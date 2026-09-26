import * as v from "valibot";

import { PatchdeskApiError } from "./api-client";
import type { LocalReviewSourceInput } from "./flows/use-inbox-review-opening";
import type { WorkbenchReviewSource } from "./review-source";
import { casesHandled } from "../../domain/result";

/**
 * The open request that reads a stored local source from the checkout again.
 * A working tree sends the `HEAD` it was opened on, so a branch switch is
 * refused rather than opening the current branch's Review.
 */
export function localReviewSourceInput(
  source: Exclude<WorkbenchReviewSource, { readonly kind: "pull_request" }>,
): LocalReviewSourceInput {
  switch (source.kind) {
    case "working_tree":
      return {
        kind: "working_tree",
        expectedHead:
          source.branch === undefined
            ? { kind: "detached" }
            : { kind: "branch", branch: source.branch },
      };
    case "branch":
      return {
        kind: "branch",
        branch: source.branch,
        baseBranch: source.baseBranch,
      };
    case "commit":
      return { kind: "commit", commit: source.commitSha };
    default:
      return casesHandled(source);
  }
}

const branchMismatchBodySchema = v.object({
  error: v.literal("branch_mismatch"),
  // Null when the checkout's `HEAD` is detached.
  currentBranch: v.nullable(v.string()),
});

/** The sentence a working-tree reopen refused for a branch switch shows; undefined for any other failure. */
export function branchMismatchMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this reads one refusal off it.
  cause: unknown,
  source: LocalReviewSourceInput,
): string | undefined {
  if (
    !(cause instanceof PatchdeskApiError) ||
    source.kind !== "working_tree" ||
    source.expectedHead === undefined
  )
    return undefined;
  const body = v.safeParse(branchMismatchBodySchema, cause.responseBody);
  if (!body.success) return undefined;
  const current = body.output.currentBranch ?? "a detached HEAD";
  const action =
    source.expectedHead.kind === "branch"
      ? `Switch to ${source.expectedHead.branch}`
      : "Detach HEAD";
  return `The checkout is on ${current}. ${action} to reopen this review.`;
}

/**
 * The sentence for a stored working-tree Review whose load was refused for a
 * branch switch (#477). Only the checkout's branch is known there, since the
 * load names the Review by id. Undefined for any other failure.
 */
export function storedBranchMismatchMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this reads one refusal off it.
  cause: unknown,
): string | undefined {
  if (!(cause instanceof PatchdeskApiError)) return undefined;
  const body = v.safeParse(branchMismatchBodySchema, cause.responseBody);
  if (!body.success) return undefined;
  const current = body.output.currentBranch ?? "a detached HEAD";
  return `The checkout is on ${current}. Switch back to the branch this review was opened on to reopen it.`;
}

const untrackedTooLargeBodySchema = v.object({
  error: v.literal("untracked_too_large"),
  largestPaths: v.array(v.string()),
});

/** The sentence for a working tree whose untracked files are over the snapshot limits (#485); undefined for any other failure. */
export function untrackedTooLargeMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this reads one refusal off it.
  cause: unknown,
): string | undefined {
  if (!(cause instanceof PatchdeskApiError)) return undefined;
  const body = v.safeParse(untrackedTooLargeBodySchema, cause.responseBody);
  if (!body.success) return undefined;
  const paths = body.output.largestPaths;
  const ignore =
    paths.length === 0 ? "large untracked folders" : paths.join(", ");
  return `The working tree has too many untracked files to snapshot. Add ${ignore} to .gitignore or remove them, then try again.`;
}
