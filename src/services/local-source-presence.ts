import { realpath } from "node:fs/promises";

import { casesHandled } from "../domain/result";
import type { LocalReviewSource } from "../domain/review-source";
import type { GitReadExecutor } from "./review-worktree-service";

/**
 * True when the repository at `localPath` still reads and the Review's source
 * certainly no longer resolves in it: its branch or base branch was deleted,
 * or its commit is gone. Every read exits 0 whether or not the name exists,
 * so a failed read (timeout, spawn failure) means unknown and keeps the
 * Review. Only ref and object lookups run, never the snapshot a working-tree
 * open writes. A detached working tree names nothing to lose, so it is never
 * gone.
 */
export async function isLocalSourceGone(
  git: GitReadExecutor,
  localPath: string,
  source: LocalReviewSource,
): Promise<boolean> {
  const repositoryPath = await realpath(localPath).catch(() => undefined);
  if (repositoryPath === undefined) return false;
  const read = async (
    ...args: ReadonlyArray<string>
  ): Promise<ReadonlyArray<string> | undefined> => {
    const result = await git.run(["git", "-C", repositoryPath, ...args]);
    return result._tag === "ok"
      ? result.value.stdout.split("\n").filter((line) => line !== "")
      : undefined;
  };
  const branchGone = async (branch: string): Promise<boolean | undefined> => {
    const ref = `refs/heads/${branch}`;
    const listed = await read("for-each-ref", "--format=%(refname)", ref);
    return listed === undefined ? undefined : !listed.includes(ref);
  };
  switch (source.kind) {
    case "working_tree":
      return (
        source.branch !== undefined &&
        (await branchGone(source.branch)) === true
      );
    case "branch": {
      const [branch, baseBranch] = await Promise.all([
        branchGone(source.branch),
        branchGone(source.baseBranch),
      ]);
      if (branch === undefined || baseBranch === undefined) return false;
      return branch || baseBranch;
    }
    case "commit": {
      const listed = await read(
        "rev-list",
        "--no-walk",
        "--ignore-missing",
        source.commitSha,
      );
      return listed !== undefined && listed.length === 0;
    }
    default:
      return casesHandled(source);
  }
}
