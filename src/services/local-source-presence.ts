import { realpath } from "node:fs/promises";

import { casesHandled } from "../domain/result";
import type { LocalReviewSource } from "../domain/review-source";
import type { GitReadExecutor } from "./review-worktree-service";

/**
 * True when the repository at `localPath` still reads and the Review's source
 * no longer resolves in it: its branch or base branch was deleted, or its
 * commit is gone. Only ref and object lookups run, never the snapshot a
 * working-tree open writes. A detached working tree names nothing to lose,
 * so it is never gone.
 */
export async function isLocalSourceGone(
  git: GitReadExecutor,
  localPath: string,
  source: LocalReviewSource,
): Promise<boolean> {
  const repositoryPath = await realpath(localPath).catch(() => undefined);
  if (repositoryPath === undefined) return false;
  const read = async (...args: ReadonlyArray<string>): Promise<boolean> =>
    (await git.run(["git", "-C", repositoryPath, ...args]))._tag === "ok";
  if (!(await read("rev-parse", "--git-dir"))) return false;
  const branchExists = (branch: string): Promise<boolean> =>
    read("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  switch (source.kind) {
    case "working_tree":
      return (
        source.branch !== undefined && !(await branchExists(source.branch))
      );
    case "branch":
      return (
        !(await branchExists(source.branch)) ||
        !(await branchExists(source.baseBranch))
      );
    case "commit":
      return !(await read("cat-file", "-e", `${source.commitSha}^{commit}`));
    default:
      return casesHandled(source);
  }
}
