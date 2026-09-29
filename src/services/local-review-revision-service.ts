import { copyFile, mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalPatchFlags } from "../adapters/process/git-patch-flags";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  detachedHeadBranch,
  parseGitSha,
  parseLocalBranchName,
  type ContentHash,
  type GitSha,
  type LocalBranchName,
  type WorkspaceProfileId,
} from "../domain/ids";
import { definedProps } from "../domain/defined-props";
import { casesHandled, err, ok, type Result } from "../domain/result";
import type { ReviewRevision } from "../domain/review-session";
import type {
  LocalReviewSource,
  LocalReviewSourceRequest,
} from "../domain/review-source";
import {
  checkUntrackedSize,
  localSnapshotUntrackedLimits,
  lstatFileSize,
  type UntrackedFileSize,
  type UntrackedLimits,
  type UntrackedTooLarge,
} from "./local-untracked-size";
import { fingerprintLocalCheckout } from "./local-checkout-fingerprint";
import { readFirstParentOrEmptyTree } from "./local-commit-listing";
import { exists } from "./review-preparation-journal";
import type { GitReadExecutor } from "./review-worktree-service";

export type LocalReviewRevisionFailure =
  /** The working tree's index holds a merge conflict, so it cannot be snapshotted. */
  | { readonly _tag: "UnmergedIndex" }
  /** `HEAD` has no commit, or the branch, base branch, merge base, or commit does not exist. */
  | { readonly _tag: "LocalRevisionNotFound" }
  | UntrackedTooLarge
  | PatchTooLarge
  | { readonly _tag: "LocalGitFailed" };

/** The patch is over the git output cap (#493). */
export type PatchTooLarge = {
  readonly _tag: "PatchTooLarge";
  /** The changed files with the most changed lines, binary files first, relative to the repository root. */
  readonly largestFiles: ReadonlyArray<string>;
};

/** How many of the largest changed files a refusal names. */
const LARGEST_CHANGED_FILE_COUNT = 5;

/** A local source spec and the head/base pair it resolved to, before any session exists. */
export type ResolvedLocalRevision = {
  readonly source: LocalReviewSource;
  readonly revision: ReviewRevision;
  /** The checkout `HEAD` a shared Review's Local snapshot was taken on; absent for the other kinds. */
  readonly checkoutHeadSha?: GitSha;
  /** `fingerprintLocalCheckout` read just before a shared Review's Local snapshot; absent for the other kinds. */
  readonly checkoutFingerprint?: ContentHash;
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
 * snapshot tree and commit objects. The maintainer's index is never written,
 * and untracked files over the limits are refused before `add -A` (#485).
 */
export class LocalReviewRevisionService {
  constructor(
    private readonly git: GitReadExecutor,
    private readonly paths: PatchdeskPaths,
    private readonly untrackedLimits: UntrackedLimits = localSnapshotUntrackedLimits,
    private readonly untrackedFileSize: UntrackedFileSize = lstatFileSize,
  ) {}

  async resolve(
    profileId: WorkspaceProfileId,
    repositoryPath: string,
    request: LocalReviewSourceRequest,
  ): Promise<Result<ResolvedLocalRevision, LocalReviewRevisionFailure>> {
    switch (request.kind) {
      case "local_branch":
        return this.resolveLocalBranch(
          profileId,
          repositoryPath,
          request.baseBranch,
        );
      case "commit":
        return this.resolveCommit(repositoryPath, request.commit);
      default:
        return casesHandled(request);
    }
  }

  /**
   * The session patch, byte for byte as `git diff` writes it; its hash is the
   * canonical patch hash. A patch over the git output cap is refused
   * `PatchTooLarge` rather than truncated.
   */
  async renderPatch(
    repositoryPath: string,
    revision: ReviewRevision,
  ): Promise<
    Result<string, { readonly _tag: "LocalGitFailed" } | PatchTooLarge>
  > {
    const diff = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "diff",
      "--binary",
      ...canonicalPatchFlags,
      revision.baseSha,
      revision.headSha,
    ]);
    if (diff._tag === "ok") return ok(diff.value.stdout);
    if (diff.error._tag !== "GitReadOutputExceeded")
      return err({ _tag: "LocalGitFailed" });
    return err({
      _tag: "PatchTooLarge",
      largestFiles: await this.largestChangedFiles(repositoryPath, revision),
    });
  }

  /** Ranked by `--numstat`; a binary file has no line counts, and its `--binary` patch carries the whole file. */
  private async largestChangedFiles(
    repositoryPath: string,
    revision: ReviewRevision,
  ): Promise<ReadonlyArray<string>> {
    const numstat = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      revision.baseSha,
      revision.headSha,
    ]);
    if (numstat._tag === "err") return [];
    const files = numstat.value.stdout.split("\0").flatMap((record) => {
      const [added, deleted, path] = record.split("\t");
      if (added === undefined || deleted === undefined || path === undefined)
        return [];
      return [
        {
          path,
          lines: added === "-" ? Infinity : Number(added) + Number(deleted),
        },
      ];
    });
    return files
      .sort((a, b) => b.lines - a.lines || 0)
      .slice(0, LARGEST_CHANGED_FILE_COUNT)
      .map((file) => file.path);
  }

  /**
   * The shared Review (#555): the Local snapshot against the merge base of
   * `HEAD` and the base branch tip, so the diff holds every change the branch
   * carries, committed or not. The base is read before the snapshot, so a
   * missing base writes no objects.
   */
  private async resolveLocalBranch(
    profileId: WorkspaceProfileId,
    repositoryPath: string,
    baseBranch: LocalBranchName,
  ): Promise<Result<ResolvedLocalRevision, LocalReviewRevisionFailure>> {
    const head = await this.readCheckoutHead(repositoryPath);
    if (head._tag === "err") return head;
    const baseTip = await this.readSha(repositoryPath, [
      "rev-parse",
      "--verify",
      `refs/heads/${baseBranch}^{commit}`,
    ]);
    if (baseTip === undefined) return err({ _tag: "LocalRevisionNotFound" });
    const mergeBase = await this.readSha(repositoryPath, [
      "merge-base",
      "--end-of-options",
      baseTip,
      head.value.sha,
    ]);
    if (mergeBase === undefined) return err({ _tag: "LocalRevisionNotFound" });
    const fingerprint = await fingerprintLocalCheckout(
      this.git,
      repositoryPath,
      { headSha: head.value.sha, mergeBase },
    );
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the ordering is the point: the fingerprint is read before the snapshot, so an edit between the two leaves an older fingerprint, a spurious update rather than a missed one; the next prepare of that session records the newer fingerprint
    const snapshot = await this.writeLocalSnapshot(
      profileId,
      repositoryPath,
      head.value.sha,
    );
    if (snapshot._tag === "err") return snapshot;
    // An unreadable fingerprint never refuses the read: the update check fingerprints a session without one on its first check.
    return ok({
      source: {
        kind: "local_branch",
        branch: head.value.branch ?? detachedHeadBranch,
        baseBranch,
      },
      revision: { headSha: snapshot.value, baseSha: mergeBase },
      checkoutHeadSha: head.value.sha,
      ...definedProps({ checkoutFingerprint: fingerprint }),
    });
  }

  /** The checkout's `HEAD` commit and the branch it names; `branch` is absent when `HEAD` is detached. */
  private async readCheckoutHead(
    repositoryPath: string,
  ): Promise<
    Result<
      { readonly sha: GitSha; readonly branch?: LocalBranchName },
      LocalReviewRevisionFailure
    >
  > {
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
    if (symbolic._tag === "err") return ok({ sha: head });
    const branch = parseLocalBranchName(symbolic.value.stdout.trim());
    return branch._tag === "ok"
      ? ok({ sha: head, branch: branch.value })
      : err({ _tag: "LocalGitFailed" });
  }

  /** Commits the working tree as a Local snapshot whose parent is `head` (ADR 0050 "The Local snapshot"). */
  private async writeLocalSnapshot(
    profileId: WorkspaceProfileId,
    repositoryPath: string,
    head: GitSha,
  ): Promise<Result<GitSha, LocalReviewRevisionFailure>> {
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
      return snapshot === undefined
        ? err({ _tag: "LocalGitFailed" })
        : ok(snapshot);
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
    const untracked = await checkUntrackedSize(
      this.git,
      repositoryPath,
      scratchIndex,
      this.untrackedLimits,
      this.untrackedFileSize,
    );
    if (untracked._tag === "err") return untracked;
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
    const baseSha = await readFirstParentOrEmptyTree(
      this.git,
      repositoryPath,
      commitSha,
    );
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
