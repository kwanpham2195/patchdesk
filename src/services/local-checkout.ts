import { realpath } from "node:fs/promises";

import { isPathContained } from "../adapters/storage/path-containment";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  parseAbsolutePath,
  parseLocalBranchName,
  type AbsolutePath,
  type LocalBranchName,
} from "../domain/ids";
import {
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "../domain/repository-identity";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { resolveCheckoutRoot } from "./local-apply-checkout";
import type { GitReadExecutor } from "./review-worktree-service";

/** What listing and resolving checkouts reads: git, and the cache directory whose worktrees are Patchdesk's own. */
export type LocalCheckoutReads = {
  readonly git: GitReadExecutor;
  readonly paths: Pick<PatchdeskPaths, "cacheDirectory">;
};

/** One live checkout of a profile repository, at its resolved top-level. */
export type RepositoryCheckout = {
  readonly path: AbsolutePath;
  readonly head:
    | { readonly kind: "branch"; readonly branch: LocalBranchName }
    | { readonly kind: "detached" };
  /** True for the profile's configured `localPath`. */
  readonly configured: boolean;
};

/**
 * Where a local Review is read and kept. `repositoryPath` is the configured
 * checkout: managed refs, session worktrees, journals and retention run there.
 * `checkoutPath` is the checkout the source is read from: the snapshot, the
 * diff and Apply. `checkout` is what the source stores, absent for the
 * configured checkout.
 */
export type LocalReviewCheckout = {
  readonly repositoryPath: string;
  readonly checkoutPath: string;
  readonly checkout?: AbsolutePath;
};

export type LocalCheckoutFailure =
  /** The repository is not in the profile, or the profile gives it no `localPath`. */
  | { readonly _tag: "RepositoryNotLocal" }
  /** The path is not a live worktree of the configured checkout's repository. */
  | { readonly _tag: "CheckoutNotInRepository" }
  | { readonly _tag: "LocalGitFailed" };

/** The profile's configured checkout of a repository, if it gives one. */
export function configuredLocalPath(
  profile: WorkspaceProfileConfig,
  repository: RepositoryIdentity,
): AbsolutePath | undefined {
  return profile.repos.find((candidate) =>
    sameRepositoryIdentity(candidate, repository),
  )?.localPath;
}

/**
 * The live checkouts `git worktree list` names from the configured checkout.
 * Bare and prunable entries, entries whose directory is gone, and Patchdesk's
 * own worktrees under the cache directory are left out. Undefined when git
 * cannot list them.
 */
export async function listRepositoryCheckouts(
  reads: LocalCheckoutReads,
  localPath: string,
): Promise<ReadonlyArray<RepositoryCheckout> | undefined> {
  const cacheDirectory = reads.paths.cacheDirectory();
  const [configured, listed, cache] = await Promise.all([
    resolveCheckoutRoot(reads.git, localPath),
    reads.git.run([
      "git",
      "-C",
      localPath,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]),
    realpath(cacheDirectory).catch(() => cacheDirectory),
  ]);
  if (configured === undefined || listed._tag === "err") return undefined;
  // `-z` ends each attribute with NUL and each entry with one more.
  const entries = listed.value.stdout
    .split("\0\0")
    .map((entry) => entry.split("\0").filter((line) => line !== ""));
  const checkouts = await Promise.all(
    entries.map(async (lines): Promise<RepositoryCheckout | undefined> => {
      const worktree = lines.find((line) => line.startsWith("worktree "));
      if (
        worktree === undefined ||
        lines.some((line) => line === "bare" || line.startsWith("prunable"))
      )
        return undefined;
      const resolved = await realpath(worktree.slice("worktree ".length)).catch(
        () => undefined,
      );
      const path = parseAbsolutePath(resolved);
      if (path._tag === "err" || isPathContained(cache, path.value))
        return undefined;
      const branch = parseLocalBranchName(
        lines
          .find((line) => line.startsWith("branch refs/heads/"))
          ?.slice("branch refs/heads/".length),
      );
      return {
        path: path.value,
        head:
          branch._tag === "ok"
            ? { kind: "branch", branch: branch.value }
            : { kind: "detached" },
        configured: path.value === configured,
      };
    }),
  );
  return checkouts.filter((checkout) => checkout !== undefined);
}

/**
 * The paths a local Review of `repository` reads, for the checkout it names.
 * A named checkout must be a live worktree of the configured checkout's
 * repository (#489): a second clone, any other directory, and Patchdesk's
 * cache worktrees are refused. It is normalized to absent when it resolves
 * to the configured checkout, so that checkout keys one Review however named.
 */
export async function resolveLocalReviewCheckout(
  reads: LocalCheckoutReads,
  profile: WorkspaceProfileConfig,
  repository: RepositoryIdentity,
  checkout: string | undefined,
): Promise<Result<LocalReviewCheckout, LocalCheckoutFailure>> {
  const localPath = configuredLocalPath(profile, repository);
  if (localPath === undefined) return err({ _tag: "RepositoryNotLocal" });
  const configured = { repositoryPath: localPath, checkoutPath: localPath };
  if (checkout === undefined) return ok(configured);
  const picked = await resolveCheckoutRoot(reads.git, checkout);
  if (picked === undefined) return err({ _tag: "CheckoutNotInRepository" });
  const checkouts = await listRepositoryCheckouts(reads, localPath);
  if (checkouts === undefined) return err({ _tag: "LocalGitFailed" });
  const match = checkouts.find((candidate) => candidate.path === picked);
  if (match === undefined) return err({ _tag: "CheckoutNotInRepository" });
  return ok(
    match.configured
      ? configured
      : { ...configured, checkoutPath: match.path, checkout: match.path },
  );
}
