import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as v from "valibot";

import type { GitHubCredentials } from "../adapters/github/github-credentials";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { isPathContained } from "../adapters/storage/path-containment";
import type {
  GitSha,
  GitHubHost,
  GitHubOwner,
  GitHubRepoName,
  PullRequestNumber,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import type { ReviewLocalCheckoutWarning } from "../domain/review-session";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";

export type GitReadExecutor = {
  readonly run: (
    argv: ReadonlyArray<string>,
    environment?: Readonly<Record<string, string>>,
  ) => Promise<
    Result<{ readonly stdout: string }, { readonly _tag: "GitReadFailed" }>
  >;
};

export type ManagedWorktree = {
  readonly mode: "worktree";
  readonly path: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly dirty: { readonly tracked: boolean; readonly untracked: boolean };
};
export type MetadataOnlyReview = {
  readonly mode: "metadata_only";
  readonly warning: ReviewLocalCheckoutWarning;
};
export type WorktreeFailure =
  | { readonly _tag: "GitWorktreeFailed" }
  // A GitHub-authenticated read has already established the immutable PR
  // snapshot by this point; a credential or `gh` failure here is a real
  // authentication problem, not a reason to silently degrade the Review.
  | { readonly _tag: "GitHubAuthenticationFailed" }
  // Distinguishes a local filesystem problem (can't create a directory or
  // write the ownership marker) from the GitHub-side failures above; both
  // fail closed, but for a different underlying reason.
  | { readonly _tag: "WorktreeStorageUnavailable" };
export type UnsafeWorktreeCleanup = { readonly _tag: "UnsafeWorktreeCleanup" };

export type WorktreeCleanupInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly localPath?: string;
  readonly targetPath: string;
};

type WorktreeInput = {
  readonly profileId: WorkspaceProfileId;
  readonly profile: WorkspaceProfileConfig;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly number: PullRequestNumber;
  readonly baseSha: GitSha;
  readonly sha: GitSha;
  readonly sessionId: ReviewSessionId;
  readonly localPath?: string;
};

/**
 * `worktree.json` is a durable ownership marker Patchdesk fully owns on both
 * the write and read side (`prepare` and `cleanup` below write it;
 * `matchesMetadata` reads it back). Per ADR 0022, structural drift here means
 * the marker is corrupt, so parsing fails the whole read closed rather than
 * degrading field by field.
 */
const worktreeMetadataSchema = v.strictObject({
  profileId: v.string(),
  sessionId: v.string(),
  baseRef: v.optional(v.string()),
  headRef: v.optional(v.string()),
});

/** Owns the only read-only git commands used to prepare a session checkout. */
export class ReviewWorktreeService {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly git: GitReadExecutor,
    private readonly credentials: GitHubCredentials,
    // Resolved per call, not cached at construction: mirrors electron-main's
    // `codexInvoke` precedent so a PATH change is picked up without a
    // restart, and so tests can stub it without touching process state.
    private readonly resolveGitHubCli: () => Promise<string | undefined>,
  ) {}

  /** Fetch immutable PR base/head SHAs into managed refs and create a detached head worktree. */
  async prepare(
    input: WorktreeInput,
  ): Promise<Result<ManagedWorktree | MetadataOnlyReview, WorktreeFailure>> {
    if (input.localPath === undefined)
      return ok({ mode: "metadata_only", warning: "missing_local_path" });
    let repositoryPath: string;
    try {
      repositoryPath = await realpath(input.localPath);
    } catch {
      return ok({
        mode: "metadata_only",
        warning: "local_checkout_unavailable",
      });
    }
    const status = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status._tag === "err")
      return ok({
        mode: "metadata_only",
        warning: "local_checkout_unavailable",
      });
    const dirty = {
      tracked: status.value.stdout
        .split("\n")
        .some((line) => line.startsWith(" ") || /^[MADRCU]/.test(line)),
      untracked: status.value.stdout
        .split("\n")
        .some((line) => line.startsWith("?? ")),
    };
    const baseRef = `refs/patchdesk/reviews/${input.profileId}/${input.sessionId}/base`;
    const headRef = `refs/patchdesk/reviews/${input.profileId}/${input.sessionId}/head`;
    // Both failures below are authentication problems, not local-checkout
    // problems: GitHub reads have already proven this PR exists, so a missing
    // profile credential or a missing `gh` binary must fail closed rather
    // than silently degrade to a metadata-only Review.
    const environment = await this.credentials.environmentFor(input.profile);
    if (environment._tag === "err")
      return err({ _tag: "GitHubAuthenticationFailed" });
    const ghPath = await this.resolveGitHubCli();
    if (ghPath === undefined)
      return err({ _tag: "GitHubAuthenticationFailed" });
    const fetchEnvironment = {
      ...environment.value,
      GIT_TERMINAL_PROMPT: "0",
    };
    const fetchedBase = await this.git.run(
      [
        ...buildGitHubManagedFetchCommand(
          input.host,
          ghPath,
          repositoryPath,
          input.baseSha,
          baseRef,
        ),
      ],
      fetchEnvironment,
    );
    if (fetchedBase._tag === "err")
      return ok({
        mode: "metadata_only",
        warning: "local_checkout_unavailable",
      });
    const fetchedHead = await this.git.run(
      [
        ...buildGitHubManagedFetchCommand(
          input.host,
          ghPath,
          repositoryPath,
          input.sha,
          headRef,
        ),
      ],
      fetchEnvironment,
    );
    if (fetchedHead._tag === "err") {
      await this.deleteManagedRef(repositoryPath, baseRef);
      return ok({
        mode: "metadata_only",
        warning: "local_checkout_unavailable",
      });
    }
    const path = this.paths.worktreeDirectory(input.profileId, input.sessionId);
    const existing = await this.matchesMetadata(
      path,
      input.profileId,
      input.sessionId,
    );
    if (!existing) {
      try {
        await mkdir(dirname(path), { recursive: true });
      } catch {
        // Nothing was created on disk yet — a filesystem failure here is a
        // storage problem, not a reason to degrade the Review, so this fails
        // closed instead of falling back to metadata-only.
        await this.deleteManagedRef(repositoryPath, baseRef);
        await this.deleteManagedRef(repositoryPath, headRef);
        return err({ _tag: "WorktreeStorageUnavailable" });
      }
      // A stale worktree registration can block the fresh `add` call; clear it
      // first so the user never has to clean it up by hand.
      await this.git.run(["git", "-C", repositoryPath, "worktree", "prune"]);
      const added = await this.git.run([
        "git",
        "-C",
        repositoryPath,
        "worktree",
        "add",
        "--detach",
        path,
        headRef,
      ]);
      if (added._tag === "err") {
        await this.deleteManagedRef(repositoryPath, baseRef);
        await this.deleteManagedRef(repositoryPath, headRef);
        return ok({
          mode: "metadata_only",
          warning: "local_checkout_unavailable",
        });
      }
      try {
        await mkdir(path, { recursive: true });
        await writeFile(
          joinMetadata(path),
          JSON.stringify({
            profileId: input.profileId,
            sessionId: input.sessionId,
            baseRef,
            headRef,
          }),
          "utf8",
        );
      } catch {
        // The worktree registration exists but its ownership marker doesn't:
        // `cleanup` can never prove ownership of it, so it must be removed
        // here, before returning, or it leaks forever.
        await this.removeCreatedWorktree(repositoryPath, path);
        await this.deleteManagedRef(repositoryPath, baseRef);
        await this.deleteManagedRef(repositoryPath, headRef);
        return err({ _tag: "WorktreeStorageUnavailable" });
      }
    }
    return ok({ mode: "worktree", path, baseRef, headRef, dirty });
  }

  /**
   * Best-effort removal of a worktree this call created but could not finish
   * registering. The failure that broke the marker write may also block
   * Git's own bookkeeping, so this unregisters the worktree with Git AND
   * removes its directory directly rather than trusting either alone.
   */
  private async removeCreatedWorktree(
    repositoryPath: string,
    path: string,
  ): Promise<void> {
    await unlink(joinMetadata(path)).catch(() => undefined);
    await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "worktree",
      "remove",
      path,
    ]);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Deletes one managed ref. Callers delete refs one statement at a time
   * rather than in a loop: concurrent `git update-ref` invocations contend on
   * the same repository's packed-refs lock, so the sequencing is a
   * correctness requirement and is written to look like one.
   */
  private async deleteManagedRef(
    repositoryPath: string,
    ref: string,
  ): Promise<void> {
    await this.git.run(["git", "-C", repositoryPath, "update-ref", "-d", ref]);
  }

  /** Remove only a verified Patchdesk-owned worktree; no broad filesystem deletion is allowed. */
  async cleanup(
    input: WorktreeCleanupInput,
  ): Promise<Result<void, UnsafeWorktreeCleanup | WorktreeFailure>> {
    const expected = this.paths.worktreeDirectory(
      input.profileId,
      input.sessionId,
    );
    if (resolve(input.targetPath) !== resolve(expected))
      return err({ _tag: "UnsafeWorktreeCleanup" });
    let root: string;
    try {
      await mkdir(this.paths.cacheDirectory(), { recursive: true });
      root = await realpath(this.paths.cacheDirectory());
    } catch {
      return err({ _tag: "UnsafeWorktreeCleanup" });
    }
    try {
      const info = await lstat(input.targetPath);
      if (info.isSymbolicLink()) return err({ _tag: "UnsafeWorktreeCleanup" });
      const target = await realpath(input.targetPath);
      if (!isPathContained(root, target))
        return err({ _tag: "UnsafeWorktreeCleanup" });
      if (
        !(await this.matchesMetadata(target, input.profileId, input.sessionId))
      )
        return err({ _tag: "UnsafeWorktreeCleanup" });
    } catch {
      return err({ _tag: "UnsafeWorktreeCleanup" });
    }
    if (input.localPath === undefined)
      return err({ _tag: "UnsafeWorktreeCleanup" });
    let repositoryPath: string;
    try {
      repositoryPath = await realpath(input.localPath);
    } catch {
      return err({ _tag: "GitWorktreeFailed" });
    }
    // Git refuses to remove a worktree with untracked files. This marker is
    // Patchdesk-owned and was safety-checked above, so remove it first.
    try {
      await unlink(joinMetadata(input.targetPath));
    } catch {
      return err({ _tag: "GitWorktreeFailed" });
    }
    const removed = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "worktree",
      "remove",
      input.targetPath,
    ]);
    if (removed._tag === "ok") return ok(undefined);
    // Keep recovery able to prove ownership if Git could not remove the
    // worktree this time. The next cleanup attempt removes the marker again.
    try {
      await writeFile(
        joinMetadata(input.targetPath),
        JSON.stringify({
          profileId: input.profileId,
          sessionId: input.sessionId,
        }),
        "utf8",
      );
    } catch {
      // The journal stays retained if this best-effort recovery marker cannot be restored.
    }
    return err({ _tag: "GitWorktreeFailed" });
  }

  private async matchesMetadata(
    path: string,
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<boolean> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(joinMetadata(path), "utf8"),
      );
      const parsed = v.safeParse(worktreeMetadataSchema, raw);
      return (
        parsed.success &&
        parsed.output.profileId === profileId &&
        parsed.output.sessionId === sessionId
      );
    } catch {
      return false;
    }
  }
}

function joinMetadata(path: string): string {
  return `${path}/worktree.json`;
}

/**
 * Builds profile-scoped HTTPS Git fetch arguments from one validated GitHub
 * host. `ghPath` must be an absolute, pre-discovered path: Git spawns the
 * credential helper via `/bin/sh` with the inherited PATH, which a
 * Finder-launched Electron app does not extend with Homebrew's `bin`, so a
 * bare `gh` is not reliably discoverable there.
 *
 * That same `/bin/sh` splits the helper on whitespace, so the path is single
 * quoted: an unquoted directory containing a space resolves to the wrong
 * command, and the fetch then fails as an unauthenticated read.
 */
function buildGitHubManagedFetchCommand(
  host: GitHubHost,
  ghPath: string,
  repositoryPath: string,
  sha: GitSha,
  ref: string,
): ReadonlyArray<string> {
  return [
    "git",
    "-c",
    `url.https://${host}/.insteadOf=git@${host}:`,
    "-c",
    `url.https://${host}/.insteadOf=ssh://git@${host}/`,
    "-c",
    `credential.https://${host}.helper=`,
    "-c",
    `credential.https://${host}.helper=!'${ghPath}' auth git-credential`,
    "-C",
    repositoryPath,
    "fetch",
    "origin",
    `${sha}:${ref}`,
    "--no-tags",
  ];
}
