import * as v from "valibot";

import { PatchdeskApiError } from "./api-client";
import type { LocalReviewSourceInput } from "./flows/use-inbox-review-opening";
import type { WorkbenchReviewSource } from "./review-source";
import { casesHandled } from "../../domain/result";

/**
 * The open request that reads a stored local source from the checkout again.
 * A shared Review sends the branch it was opened on, so a branch switch is
 * refused rather than opening the current branch's Review. Undefined for a
 * working-tree or branch Review stored before the shared Review (#555),
 * which nothing reads again.
 */
export function localReviewSourceInput(
  source: Exclude<WorkbenchReviewSource, { readonly kind: "pull_request" }>,
): LocalReviewSourceInput | undefined {
  switch (source.kind) {
    case "working_tree":
    case "branch":
      return undefined;
    case "local_branch":
      return {
        kind: "local_branch",
        baseBranch: source.baseBranch,
        expectedHead:
          source.branch === "detached"
            ? { kind: "detached" }
            : { kind: "branch", branch: source.branch },
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

/** The sentence a shared Review reopen refused for a branch switch shows; undefined for any other failure. */
export function branchMismatchMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this reads one refusal off it.
  cause: unknown,
  source: LocalReviewSourceInput,
): string | undefined {
  if (
    !(cause instanceof PatchdeskApiError) ||
    source.kind !== "local_branch" ||
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
 * The sentence for a stored shared Review whose load was refused for a
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
  exceededLimit: v.picklist(["files", "bytes"]),
  largestPaths: v.array(v.string()),
});

/** The sentence for a working tree whose untracked files are over a snapshot limit (#485), naming that limit; undefined for any other failure. */
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
  const exceeded =
    body.output.exceededLimit === "files"
      ? "more than 5,000 untracked files"
      : "more than 100 MiB of untracked files";
  return `The working tree has ${exceeded}, more than Patchdesk snapshots. Add ${ignore} to .gitignore or remove them, then try again.`;
}

const patchTooLargeBodySchema = v.object({
  error: v.literal("patch_too_large"),
  largestFiles: v.array(v.string()),
});

/** The sentence for a local source whose patch is over the git output cap (#493); undefined for any other failure. */
export function patchTooLargeMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this reads one refusal off it.
  cause: unknown,
): string | undefined {
  if (!(cause instanceof PatchdeskApiError)) return undefined;
  const body = v.safeParse(patchTooLargeBodySchema, cause.responseBody);
  if (!body.success) return undefined;
  const files = body.output.largestFiles;
  return files.length === 0
    ? "The change is larger than the 2 MiB patch Patchdesk can read. Leave large generated files out, or review it in smaller parts."
    : `The change is larger than the 2 MiB patch Patchdesk can read. The largest changes are in ${files.join(", ")}. Leave generated files out, or review it in smaller parts.`;
}

const checkoutMissingBodySchema = v.object({
  error: v.literal("checkout_missing"),
  localPath: v.string(),
});

/** The sentence for a repository whose configured checkout is gone, as after a move on disk (#488); undefined for any other failure. */
export function checkoutMissingMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this reads one refusal off it.
  cause: unknown,
): string | undefined {
  if (!(cause instanceof PatchdeskApiError)) return undefined;
  const body = v.safeParse(checkoutMissingBodySchema, cause.responseBody);
  if (!body.success) return undefined;
  return `Patchdesk cannot find this repository's checkout at ${body.output.localPath}. If you moved it, open Settings → Workspace and, under Repositories, add the folder that holds it now if it is not listed, then untick the repository and tick it again.`;
}
