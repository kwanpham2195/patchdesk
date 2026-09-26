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
import {
  parseReviewSessionId,
  type GitSha,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type PullRequestNumber,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { ReviewLocalCheckoutWarning } from "../domain/review-session";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { definedProps } from "../domain/defined-props";
import { mapConcurrent } from "../domain/map-concurrent";
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

/** One ref under `refs/patchdesk/`, and the session whose checkout it pins. */
export type ManagedRef = {
  readonly ref: string;
  readonly sessionId: ReviewSessionId;
};

/** The managed refs an ownership marker names, which cleanup deletes with the worktree. */
type MarkerRefs = {
  readonly baseRef?: string;
  readonly headRef?: string;
};

/** One immutable SHA and the managed ref a fetch writes it to. */
type ManagedFetchRefspec = {
  readonly sha: GitSha;
  readonly ref: string;
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
  /** Recreate a verified app-owned worktree even when its marker still matches. */
  readonly replaceExisting?: boolean;
  readonly localPath?: string;
};

/**
 * `worktree.json` is a durable ownership marker Patchdesk fully owns on both
 * the write and read side (`prepare` and `cleanup` below write it;
 * `ownedMarkerRefs` reads it back). Per ADR 0022, structural drift here means
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
    private readonly credentials: Pick<GitHubCredentials, "environmentFor">,
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
    const baseRef = pullRequestSessionRef(
      input.profileId,
      input.sessionId,
      "base",
    );
    const headRef = pullRequestSessionRef(
      input.profileId,
      input.sessionId,
      "head",
    );
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
    const fetched = await this.git.run(
      buildGitHubManagedFetchCommand(input.host, ghPath, repositoryPath, [
        { sha: input.baseSha, ref: baseRef },
        { sha: input.sha, ref: headRef },
      ]),
      fetchEnvironment,
    );
    if (fetched._tag === "err") {
      // A single fetch can update one refspec and still exit nonzero on the
      // other, so neither ref can be assumed absent. Deleting a ref that was
      // never written is a harmless no-op; leaving an orphan is not.
      await this.deleteManagedRef(repositoryPath, baseRef);
      await this.deleteManagedRef(repositoryPath, headRef);
      return ok({
        mode: "metadata_only",
        warning: "local_checkout_unavailable",
      });
    }
    const checkedOut = await this.checkOutManagedHead({
      repositoryPath,
      profileId: input.profileId,
      sessionId: input.sessionId,
      localPath: input.localPath,
      headRef,
      markerRefs: { baseRef, headRef },
      ...definedProps({ replaceExisting: input.replaceExisting }),
    });
    if (checkedOut._tag === "ok")
      return ok({ mode: "worktree", path: checkedOut.value, baseRef, headRef });
    // The existing worktree still stands when only its replacement failed.
    if (checkedOut.error === "replace_failed")
      return err({ _tag: "WorktreeStorageUnavailable" });
    await this.deleteManagedRef(repositoryPath, baseRef);
    await this.deleteManagedRef(repositoryPath, headRef);
    return checkedOut.error === "worktree_add_failed"
      ? ok({ mode: "metadata_only", warning: "local_checkout_unavailable" })
      : err({ _tag: "WorktreeStorageUnavailable" });
  }

  /**
   * Pins a local source's head SHA under `refs/patchdesk/local/` and checks
   * it out detached under the app cache (ADR 0050). Unlike a pull request,
   * a local source cannot fall back to a metadata-only Review: the checkout
   * it failed to read is the source itself.
   */
  async prepareLocal(input: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
    readonly localPath: string;
    readonly headSha: GitSha;
  }): Promise<Result<{ readonly path: string }, WorktreeFailure>> {
    let repositoryPath: string;
    try {
      repositoryPath = await realpath(input.localPath);
    } catch {
      return err({ _tag: "GitWorktreeFailed" });
    }
    const headRef = localSessionHeadRef(input.profileId, input.sessionId);
    const pinned = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "update-ref",
      headRef,
      input.headSha,
    ]);
    if (pinned._tag === "err") return err({ _tag: "GitWorktreeFailed" });
    const checkedOut = await this.checkOutManagedHead({
      repositoryPath,
      profileId: input.profileId,
      sessionId: input.sessionId,
      localPath: input.localPath,
      headRef,
      markerRefs: { headRef },
    });
    if (checkedOut._tag === "ok") return ok({ path: checkedOut.value });
    await this.deleteManagedRef(repositoryPath, headRef);
    return err({
      _tag:
        checkedOut.error === "worktree_add_failed"
          ? "GitWorktreeFailed"
          : "WorktreeStorageUnavailable",
    });
  }

  /**
   * The one owner of `git worktree add --detach` and the ownership marker for
   * both source kinds. A worktree whose marker already names this session is
   * reused. The caller deletes its managed refs when this fails.
   */
  private async checkOutManagedHead(input: {
    readonly repositoryPath: string;
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
    readonly localPath: string;
    readonly headRef: string;
    readonly markerRefs: {
      readonly baseRef?: string;
      readonly headRef: string;
    };
    readonly replaceExisting?: boolean;
  }): Promise<
    Result<string, "worktree_add_failed" | "replace_failed" | "storage">
  > {
    const { repositoryPath } = input;
    const path = this.paths.worktreeDirectory(input.profileId, input.sessionId);
    let existing =
      (await this.ownedMarkerRefs(path, input.profileId, input.sessionId)) !==
      undefined;
    if (existing && input.replaceExisting === true) {
      // The refs this call just pinned stay: only the checkout is replaced.
      const removed = await this.removeOwnedWorktree({
        profileId: input.profileId,
        sessionId: input.sessionId,
        targetPath: path,
        localPath: input.localPath,
      });
      if (removed._tag === "err") return err("replace_failed");
      existing = false;
    }
    if (existing) return ok(path);
    try {
      await mkdir(dirname(path), { recursive: true });
    } catch {
      // Nothing was created on disk yet — a filesystem failure here is a
      // storage problem, not a reason to degrade the Review.
      return err("storage");
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
      input.headRef,
    ]);
    if (added._tag === "err") return err("worktree_add_failed");
    try {
      await mkdir(path, { recursive: true });
      // Deliberately not `writeAtomicFile` (M5): this marker lives inside a
      // git worktree, where `git worktree remove` refuses to run over any
      // untracked file. This code already knows to `unlink(joinMetadata(path))`
      // by its fixed name before removing the worktree; a temp-then-rename
      // write would risk leaving a randomly-named `.tmp` sibling behind on a
      // crash that this cleanup path can't find by name, newly blocking
      // `git worktree remove` in a way plain `writeFile` never could. A
      // write that throws here is already handled: `ownedMarkerRefs`'s
      // JSON.parse fails closed, and the `catch` below calls
      // `removeCreatedWorktree` to tear down the whole worktree.
      // A crash mid-write is not the same case: nothing runs to tear the
      // worktree down then. Atomicity would not help there either -- a
      // crash during the write itself leaves no marker under either
      // scheme -- and it would add a new failure mode of its own: an
      // orphaned `.tmp` file in a directory that must stay clean of
      // anything Git doesn't expect.
      await writeFile(
        joinMetadata(path),
        JSON.stringify({
          profileId: input.profileId,
          sessionId: input.sessionId,
          ...input.markerRefs,
        }),
        "utf8",
      );
    } catch {
      // The worktree registration exists but its ownership marker doesn't:
      // `cleanup` can never prove ownership of it, so it must be removed
      // here, before returning, or it leaks forever.
      await this.removeCreatedWorktree(repositoryPath, path);
      return err("storage");
    }
    return ok(path);
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

  /**
   * The profile's managed refs in one repository, each with the session it
   * names. Undefined when the repository cannot be read.
   */
  async listManagedRefs(
    profileId: WorkspaceProfileId,
    localPath: string,
  ): Promise<ReadonlyArray<ManagedRef> | undefined> {
    const repositoryPath = await realpath(localPath).catch(() => undefined);
    if (repositoryPath === undefined) return undefined;
    const listed = await this.git.run([
      "git",
      "-C",
      repositoryPath,
      "for-each-ref",
      "--format=%(refname)",
      `refs/patchdesk/local/${profileId}/`,
      `refs/patchdesk/reviews/${profileId}/`,
    ]);
    if (listed._tag === "err") return undefined;
    return listed.value.stdout.split("\n").flatMap((ref) => {
      const sessionId = parseReviewSessionId(ref.split("/")[4]);
      if (sessionId._tag === "err") return [];
      const owned = [
        pullRequestSessionRef(profileId, sessionId.value, "base"),
        pullRequestSessionRef(profileId, sessionId.value, "head"),
        localSessionHeadRef(profileId, sessionId.value),
      ];
      return owned.includes(ref) ? [{ ref, sessionId: sessionId.value }] : [];
    });
  }

  /** Deletes managed refs one at a time, then prunes Git's metadata of removed worktrees. */
  async deleteManagedRefs(
    localPath: string,
    refs: ReadonlyArray<ManagedRef>,
  ): Promise<void> {
    const repositoryPath = await realpath(localPath).catch(() => undefined);
    if (repositoryPath === undefined) return;
    await mapConcurrent(refs, 1, ({ ref }) =>
      this.deleteManagedRef(repositoryPath, ref),
    );
    await this.git.run(["git", "-C", repositoryPath, "worktree", "prune"]);
  }

  /**
   * Remove only a verified Patchdesk-owned worktree, then the managed refs its
   * marker names, then Git's worktree metadata; no broad filesystem deletion
   * is allowed. The refs go only after `git worktree remove` succeeded, so a
   * worktree Git kept still has the ref it checked out.
   */
  async cleanup(
    input: WorktreeCleanupInput,
  ): Promise<Result<void, UnsafeWorktreeCleanup | WorktreeFailure>> {
    const removed = await this.removeOwnedWorktree(input);
    if (removed._tag === "err") return removed;
    const { repositoryPath, refs } = removed.value;
    if (refs.baseRef !== undefined)
      await this.deleteManagedRef(repositoryPath, refs.baseRef);
    if (refs.headRef !== undefined)
      await this.deleteManagedRef(repositoryPath, refs.headRef);
    await this.git.run(["git", "-C", repositoryPath, "worktree", "prune"]);
    return ok(undefined);
  }

  private async removeOwnedWorktree(
    input: WorktreeCleanupInput,
  ): Promise<
    Result<
      { readonly repositoryPath: string; readonly refs: MarkerRefs },
      UnsafeWorktreeCleanup | WorktreeFailure
    >
  > {
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
    let refs: MarkerRefs | undefined;
    try {
      const info = await lstat(input.targetPath);
      if (info.isSymbolicLink()) return err({ _tag: "UnsafeWorktreeCleanup" });
      const target = await realpath(input.targetPath);
      if (!isPathContained(root, target))
        return err({ _tag: "UnsafeWorktreeCleanup" });
      refs = await this.ownedMarkerRefs(
        target,
        input.profileId,
        input.sessionId,
      );
      if (refs === undefined) return err({ _tag: "UnsafeWorktreeCleanup" });
    } catch {
      return err({ _tag: "UnsafeWorktreeCleanup" });
    }
    if (input.localPath === undefined || refs === undefined)
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
    if (removed._tag === "ok") return ok({ repositoryPath, refs });
    // Keep recovery able to prove ownership if Git could not remove the
    // worktree this time. The next cleanup attempt removes the marker again.
    // Deliberately not `writeAtomicFile` (M5): same reasoning as the marker
    // write in `register` above — this rewrites the same in-worktree file,
    // and a stray temp file here would carry the identical
    // `git worktree remove` risk.
    try {
      await writeFile(
        joinMetadata(input.targetPath),
        JSON.stringify({
          profileId: input.profileId,
          sessionId: input.sessionId,
          ...refs,
        }),
        "utf8",
      );
    } catch {
      // The journal stays retained if this best-effort recovery marker cannot be restored.
    }
    return err({ _tag: "GitWorktreeFailed" });
  }

  /**
   * The managed refs the marker names when it proves this session owns the
   * worktree, else undefined. A ref outside this session's own names is
   * dropped, so a corrupt marker can never delete another ref.
   */
  private async ownedMarkerRefs(
    path: string,
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<MarkerRefs | undefined> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(joinMetadata(path), "utf8"),
      );
      const parsed = v.safeParse(worktreeMetadataSchema, raw);
      if (
        !parsed.success ||
        parsed.output.profileId !== profileId ||
        parsed.output.sessionId !== sessionId
      )
        return undefined;
      const owned = new Set([
        pullRequestSessionRef(profileId, sessionId, "base"),
        pullRequestSessionRef(profileId, sessionId, "head"),
        localSessionHeadRef(profileId, sessionId),
      ]);
      const { baseRef, headRef } = parsed.output;
      return definedProps({
        baseRef:
          baseRef !== undefined && owned.has(baseRef) ? baseRef : undefined,
        headRef:
          headRef !== undefined && owned.has(headRef) ? headRef : undefined,
      });
    } catch {
      return undefined;
    }
  }
}

/** The managed refs a pull request session's fetch writes. */
function pullRequestSessionRef(
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
  side: "base" | "head",
): string {
  return `refs/patchdesk/reviews/${profileId}/${sessionId}/${side}`;
}

/** The managed ref a local session's head is pinned under (ADR 0050 "The Local snapshot"). */
function localSessionHeadRef(
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
): string {
  return `refs/patchdesk/local/${profileId}/${sessionId}/head`;
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
 *
 * All refspecs travel in one invocation. Every extra `git fetch` spawns its
 * own `gh auth git-credential` helper process, which has a measured floor of
 * roughly 240ms before any network work begins.
 */
function buildGitHubManagedFetchCommand(
  host: GitHubHost,
  ghPath: string,
  repositoryPath: string,
  refspecs: ReadonlyArray<ManagedFetchRefspec>,
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
    ...refspecs.map(({ sha, ref }) => `${sha}:${ref}`),
    "--no-tags",
  ];
}
