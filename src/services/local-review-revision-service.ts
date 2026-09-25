import { copyFile, mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  parseGitSha,
  parseLocalBranchName,
  type GitSha,
  type LocalBranchName,
  type WorkspaceProfileId,
} from "../domain/ids";
import { casesHandled, err, ok, type Result } from "../domain/result";
import type { ReviewRevision } from "../domain/review-session";
import type {
  LocalReviewSource,
  LocalReviewSourceRequest,
} from "../domain/review-source";
import { exists } from "./review-preparation-journal";
import type { GitReadExecutor } from "./review-worktree-service";

export type LocalReviewRevisionFailure =
  /** The working tree's index holds a merge conflict, so it cannot be snapshotted. */
  | { readonly _tag: "UnmergedIndex" }
  /** `HEAD` has no commit, or the branch, base branch, merge base, or commit does not exist. */
  | { readonly _tag: "LocalRevisionNotFound" }
  | { readonly _tag: "LocalGitFailed" };

/** A local source spec and the head/base pair it resolved to, before any session exists. */
export type ResolvedLocalRevision = {
  readonly source: LocalReviewSource;
  readonly revision: ReviewRevision;
};

/**
 * Fixed so the same tree on the same `HEAD` always commits to the same SHA
 * (ADR 0050 "The Local snapshot"); the date is fixed for the same reason.
 */
const localSnapshotIdentity = {
  GIT_AUTHOR_NAME: "Patchdesk",
  GIT_AUTHOR_EMAIL: "local-snapshot@patchdesk.invalid",
  GIT_AUTHOR_DATE: "946684800 +0000",
  GIT_COMMITTER_NAME: "Patchdesk",
  GIT_COMMITTER_EMAIL: "local-snapshot@patchdesk.invalid",
  GIT_COMMITTER_DATE: "946684800 +0000",
} as const;
const localSnapshotMessage = "Patchdesk local snapshot";

/**
 * Resolves a local Review source to its head and base SHAs from the
 * maintainer's checkout, and renders its patch. The only writes are the ones
 * ADR 0050 lists: blobs from `add -A` into a temporary index copy, and the
 * snapshot tree and commit objects. The maintainer's index is never written.
 */
export class LocalReviewRevisionService {
  constructor(
    private readonly git: GitReadExecutor,
    private readonly paths: PatchdeskPaths,
  ) {}

  async resolve(
    profileId: WorkspaceProfileId,
    repositoryPath: string,
    request: LocalReviewSourceRequest,
  ): Promise<Result<ResolvedLocalRevision, LocalReviewRevisionFailure>> {
    switch (request.kind) {
      case "working_tree":
        return this.snapshotWorkingTree(profileId, repositoryPath);
      case "branch":
        return this.resolveBranch(
          repositoryPath,
          request.branch,
          request.baseBranch,
        );
      case "commit":
        return this.resolveCommit(repositoryPath, request.commit);
      default:
        return casesHandled(request);
    }
  }

  /** The session patch, byte for byte as `git diff` writes it; its hash is the canonical patch hash. */
  async renderPatch(
    repositoryPath: string,
    revision: ReviewRevision,
  ): Promise<Result<string, { readonly _tag: "LocalGitFailed" }>> {
    const diff = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      // The patch parser needs a/ and b/ paths from the repository root with no escape codes, whatever the maintainer's diff config says.
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-relative",
      revision.baseSha,
      revision.headSha,
    ]);
    return diff._tag === "ok"
      ? ok(diff.value.stdout)
      : err({ _tag: "LocalGitFailed" });
  }

  private async snapshotWorkingTree(
    profileId: WorkspaceProfileId,
    repositoryPath: string,
  ): Promise<Result<ResolvedLocalRevision, LocalReviewRevisionFailure>> {
    const head = await this.readSha(repositoryPath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    if (head === undefined) return err({ _tag: "LocalRevisionNotFound" });
    // `-q` exits nonzero with no output when `HEAD` is detached.
    const symbolic = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]);
    let branch: LocalBranchName | undefined;
    if (symbolic._tag === "ok") {
      const parsed = parseLocalBranchName(symbolic.value.stdout.trim());
      if (parsed._tag === "err") return err({ _tag: "LocalGitFailed" });
      branch = parsed.value;
    }
    const indexPath = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "rev-parse",
      "--git-path",
      "index",
    ]);
    if (indexPath._tag === "err") return err({ _tag: "LocalGitFailed" });
    const scratchRoot = this.paths.localSnapshotScratchDirectory(profileId);
    let scratch: string;
    try {
      await mkdir(scratchRoot, { recursive: true });
      scratch = await mkdtemp(join(scratchRoot, "index-"));
    } catch {
      return err({ _tag: "LocalGitFailed" });
    }
    try {
      const tree = await this.writeSnapshotTree(
        repositoryPath,
        // `--git-path` answers relative to the directory git ran in.
        resolve(repositoryPath, indexPath.value.stdout.trim()),
        join(scratch, "index"),
      );
      if (tree._tag === "err") return tree;
      const snapshot = await this.readSha(
        repositoryPath,
        [
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          tree.value,
          "-p",
          head,
          "-m",
          localSnapshotMessage,
        ],
        localSnapshotIdentity,
      );
      if (snapshot === undefined) return err({ _tag: "LocalGitFailed" });
      return ok({
        source:
          branch === undefined
            ? { kind: "working_tree" }
            : { kind: "working_tree", branch },
        revision: { headSha: snapshot, baseSha: head },
      });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  /** Builds the snapshot tree in a copy of the index, so the maintainer's own index is only read. */
  private async writeSnapshotTree(
    repositoryPath: string,
    indexPath: string,
    scratchIndexPath: string,
  ): Promise<Result<GitSha, LocalReviewRevisionFailure>> {
    const copied = await copyIndexKeepingMtime(indexPath, scratchIndexPath);
    // A repository whose index was never written snapshots from an empty one.
    if (!copied && (await exists(indexPath)))
      return err({ _tag: "LocalGitFailed" });
    const scratchIndex = { GIT_INDEX_FILE: scratchIndexPath };
    const unmerged = await this.git.run(
      ["git", "-C", repositoryPath, "ls-files", "--unmerged"],
      scratchIndex,
    );
    if (unmerged._tag === "err") return err({ _tag: "LocalGitFailed" });
    if (unmerged.value.stdout.trim() !== "")
      return err({ _tag: "UnmergedIndex" });
    const added = await this.git.run(
      ["git", "-C", repositoryPath, "add", "-A"],
      scratchIndex,
    );
    if (added._tag === "err") return err({ _tag: "LocalGitFailed" });
    const tree = await this.readSha(
      repositoryPath,
      ["write-tree"],
      scratchIndex,
    );
    return tree === undefined ? err({ _tag: "LocalGitFailed" }) : ok(tree);
  }

  private async resolveBranch(
    repositoryPath: string,
    branch: LocalBranchName,
    baseBranch: LocalBranchName,
  ): Promise<Result<ResolvedLocalRevision, LocalReviewRevisionFailure>> {
    const [tip, baseTip] = await Promise.all([
      this.readSha(repositoryPath, [
        "rev-parse",
        "--verify",
        `refs/heads/${branch}^{commit}`,
      ]),
      this.readSha(repositoryPath, [
        "rev-parse",
        "--verify",
        `refs/heads/${baseBranch}^{commit}`,
      ]),
    ]);
    if (tip === undefined || baseTip === undefined)
      return err({ _tag: "LocalRevisionNotFound" });
    const mergeBase = await this.readSha(repositoryPath, [
      "merge-base",
      "--end-of-options",
      tip,
      baseTip,
    ]);
    if (mergeBase === undefined) return err({ _tag: "LocalRevisionNotFound" });
    return ok({
      source: { kind: "branch", branch, baseBranch },
      revision: { headSha: tip, baseSha: mergeBase },
    });
  }

  private async resolveCommit(
    repositoryPath: string,
    commit: string,
  ): Promise<Result<ResolvedLocalRevision, LocalReviewRevisionFailure>> {
    const commitSha = await this.readSha(repositoryPath, [
      "rev-parse",
      "--verify",
      `${commit}^{commit}`,
    ]);
    // Git prefers a branch or tag named like the prefix over the object, with only a warning.
    if (commitSha === undefined || !commitSha.startsWith(commit))
      return err({ _tag: "LocalRevisionNotFound" });
    const parents = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "rev-list",
      "--parents",
      "-n",
      "1",
      "--end-of-options",
      commitSha,
    ]);
    if (parents._tag === "err") return err({ _tag: "LocalGitFailed" });
    const firstParent = parents.value.stdout.trim().split(" ")[1];
    // A root commit has no parent, so it is compared with the empty tree.
    const baseSha =
      firstParent === undefined
        ? await this.readSha(repositoryPath, [
            "hash-object",
            "-t",
            "tree",
            "/dev/null",
          ])
        : parseGitShaOrUndefined(firstParent);
    if (baseSha === undefined) return err({ _tag: "LocalGitFailed" });
    return ok({
      source: { kind: "commit", commitSha },
      revision: { headSha: commitSha, baseSha },
    });
  }

  private async readSha(
    repositoryPath: string,
    args: ReadonlyArray<string>,
    environment?: Readonly<Record<string, string>>,
  ): Promise<GitSha | undefined> {
    const read = await this.git.run(
      ["git", "-C", repositoryPath, ...args],
      environment,
    );
    return read._tag === "ok"
      ? parseGitShaOrUndefined(read.value.stdout.trim())
      : undefined;
  }
}

/**
 * Git rereads an entry's content only when its mtime is not older than the
 * index file's own mtime (racy git). A copy stamped "now" would hide a
 * same-size edit made in the same second as the last index write.
 */
async function copyIndexKeepingMtime(
  indexPath: string,
  copyPath: string,
): Promise<boolean> {
  try {
    const original = await stat(indexPath);
    await copyFile(indexPath, copyPath);
    await utimes(copyPath, original.atime, original.mtime);
    return true;
  } catch {
    return false;
  }
}

function parseGitShaOrUndefined(value: string): GitSha | undefined {
  const parsed = parseGitSha(value);
  return parsed._tag === "ok" ? parsed.value : undefined;
}
