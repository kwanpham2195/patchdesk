import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { GitSha, GitHubHost, GitHubOwner, GitHubRepoName, PullRequestNumber, ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";

export type GitReadExecutor = {
  readonly run: (argv: ReadonlyArray<string>) => Promise<Result<{ readonly stdout: string }, { readonly _tag: "GitReadFailed" }>>;
};

export type ManagedWorktree = {
  readonly mode: "worktree";
  readonly path: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly dirty: { readonly tracked: boolean; readonly untracked: boolean };
};
export type MetadataOnlyReview = { readonly mode: "metadata_only"; readonly warning: "missing_local_path" };
export type WorktreeFailure = { readonly _tag: "GitWorktreeFailed" };
export type UnsafeWorktreeCleanup = { readonly _tag: "UnsafeWorktreeCleanup" };

export type WorktreeCleanupInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly localPath?: string;
  readonly targetPath: string;
};

type WorktreeInput = {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly number: PullRequestNumber;
  readonly baseSha: GitSha;
  readonly sha: GitSha;
  readonly sessionId: ReviewSessionId;
  readonly localPath?: string;
};

/** Owns the only read-only git commands used to prepare a session checkout. */
export class ReviewWorktreeService {
  constructor(private readonly paths: PatchdeskPaths, private readonly git: GitReadExecutor) {}

/** Fetch immutable PR base/head SHAs into managed refs and create a detached head worktree. */
  async prepare(input: WorktreeInput): Promise<Result<ManagedWorktree | MetadataOnlyReview, WorktreeFailure>> {
    if (input.localPath === undefined) return ok({ mode: "metadata_only", warning: "missing_local_path" });
    let repositoryPath: string;
    try { repositoryPath = await realpath(input.localPath); } catch { return err({ _tag: "GitWorktreeFailed" }); }
    const status = await this.git.run(["git", "-C", repositoryPath, "status", "--porcelain=v1", "--untracked-files=all"]);
    if (status._tag === "err") return err({ _tag: "GitWorktreeFailed" });
    const dirty = {
      tracked: status.value.stdout.split("\n").some((line) => line.startsWith(" ") || /^[MADRCU]/.test(line)),
      untracked: status.value.stdout.split("\n").some((line) => line.startsWith("?? ")),
    };
    const baseRef = `refs/patchdesk/reviews/${input.profileId}/${input.sessionId}/base`;
    const headRef = `refs/patchdesk/reviews/${input.profileId}/${input.sessionId}/head`;
    const fetchedBase = await this.git.run(["git", "-C", repositoryPath, "fetch", "origin", `${input.baseSha}:${baseRef}`, "--no-tags"]);
    if (fetchedBase._tag === "err") return err({ _tag: "GitWorktreeFailed" });
    const fetchedHead = await this.git.run(["git", "-C", repositoryPath, "fetch", "origin", `${input.sha}:${headRef}`, "--no-tags"]);
    if (fetchedHead._tag === "err") return err({ _tag: "GitWorktreeFailed" });
    const path = this.paths.worktreeDirectory(input.profileId, input.sessionId);
    const existing = await this.matchesMetadata(path, input.profileId, input.sessionId);
    if (!existing) {
      await mkdir(dirname(path), { recursive: true });
      // A stale worktree registration can block the fresh `add` call; clear it
      // first so the user never has to clean it up by hand.
      await this.git.run(["git", "-C", repositoryPath, "worktree", "prune"]);
      const added = await this.git.run(["git", "-C", repositoryPath, "worktree", "add", "--detach", path, headRef]);
      if (added._tag === "err") return err({ _tag: "GitWorktreeFailed" });
      await mkdir(path, { recursive: true });
      await writeFile(joinMetadata(path), JSON.stringify({ profileId: input.profileId, sessionId: input.sessionId, baseRef, headRef }), "utf8");
    }
    return ok({ mode: "worktree", path, baseRef, headRef, dirty });
  }

  /** Remove only a verified Patchdesk-owned worktree; no broad filesystem deletion is allowed. */
  async cleanup(input: WorktreeCleanupInput): Promise<Result<void, UnsafeWorktreeCleanup | WorktreeFailure>> {
    const expected = this.paths.worktreeDirectory(input.profileId, input.sessionId);
    if (resolve(input.targetPath) !== resolve(expected)) return err({ _tag: "UnsafeWorktreeCleanup" });
    let root: string;
    try { await mkdir(this.paths.cacheDirectory(), { recursive: true }); root = await realpath(this.paths.cacheDirectory()); } catch { return err({ _tag: "UnsafeWorktreeCleanup" }); }
    try {
      const info = await lstat(input.targetPath);
      if (info.isSymbolicLink()) return err({ _tag: "UnsafeWorktreeCleanup" });
      const target = await realpath(input.targetPath);
      if (relative(root, target).startsWith("..")) return err({ _tag: "UnsafeWorktreeCleanup" });
      if (!(await this.matchesMetadata(target, input.profileId, input.sessionId))) return err({ _tag: "UnsafeWorktreeCleanup" });
    } catch { return err({ _tag: "UnsafeWorktreeCleanup" }); }
    if (input.localPath === undefined) return err({ _tag: "UnsafeWorktreeCleanup" });
    let repositoryPath: string;
    try { repositoryPath = await realpath(input.localPath); } catch { return err({ _tag: "GitWorktreeFailed" }); }
    // Git refuses to remove a worktree with untracked files. This marker is
    // Patchdesk-owned and was safety-checked above, so remove it first.
    try { await unlink(joinMetadata(input.targetPath)); } catch { return err({ _tag: "GitWorktreeFailed" }); }
    const removed = await this.git.run(["git", "-C", repositoryPath, "worktree", "remove", input.targetPath]);
    if (removed._tag === "ok") return ok(undefined);
    // Keep recovery able to prove ownership if Git could not remove the
    // worktree this time. The next cleanup attempt removes the marker again.
    try {
      await writeFile(joinMetadata(input.targetPath), JSON.stringify({ profileId: input.profileId, sessionId: input.sessionId }), "utf8");
    } catch {
      // The journal stays retained if this best-effort recovery marker cannot be restored.
    }
    return err({ _tag: "GitWorktreeFailed" });
  }

  private async matchesMetadata(path: string, profileId: WorkspaceProfileId, sessionId: ReviewSessionId): Promise<boolean> {
    try {
      const raw: unknown = JSON.parse(await readFile(joinMetadata(path), "utf8"));
      return typeof raw === "object" && raw !== null && (raw as { profileId?: unknown }).profileId === profileId && (raw as { sessionId?: unknown }).sessionId === sessionId;
    } catch { return false; }
  }
}

function joinMetadata(path: string): string { return `${path}/worktree.json`; }
