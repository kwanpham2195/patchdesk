import { realpath } from "node:fs/promises";

import { isPathContained } from "../adapters/storage/path-containment";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  checkoutFolderName,
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

/** A checkout as the open dialog and the MCP `list_repositories` tool show it. */
export type RepositoryCheckoutDescription = RepositoryCheckout & {
  readonly name: string;
};

export function describeRepositoryCheckout(
  checkout: RepositoryCheckout,
): RepositoryCheckoutDescription {
  return {
    path: checkout.path,
    name: checkoutFolderName(checkout.path),
    head: checkout.head,
    configured: checkout.configured,
  };
}

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
  return (await readCheckoutListing(reads, localPath))?.live;
}

/**
 * Whether a named checkout is gone: false while it is listed live and is not
 * the configured checkout, and undefined when that is unknown, because git
 * failed or the worktree is locked (`git worktree lock`) with its directory
 * missing, as on removable media. True otherwise.
 */
export async function isNamedCheckoutGone(
  reads: LocalCheckoutReads,
  localPath: string,
  checkout: AbsolutePath,
): Promise<boolean | undefined> {
  const listing = await readCheckoutListing(reads, localPath);
  if (listing === undefined || listing.unreachableLocked.includes(checkout))
    return undefined;
  // A checkout that became the configured one no longer keys the Reviews that name it.
  return !listing.live.some(
    (candidate) => candidate.path === checkout && !candidate.configured,
  );
}

async function readCheckoutListing(
  reads: LocalCheckoutReads,
  localPath: string,
): Promise<
  | {
      readonly live: ReadonlyArray<RepositoryCheckout>;
      /** Locked worktrees whose directory is missing, as git lists them. */
      readonly unreachableLocked: ReadonlyArray<string>;
    }
  | undefined
> {
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
  const read = await Promise.all(
    entries.map(
      async (
        lines,
      ): Promise<
        | { readonly live: RepositoryCheckout }
        | { readonly unreachableLocked: string }
        | undefined
      > => {
        const listedPath = lines
          .find((line) => line.startsWith("worktree "))
          ?.slice("worktree ".length);
        if (
          listedPath === undefined ||
          lines.some((line) => line === "bare" || line.startsWith("prunable"))
        )
          return undefined;
        const resolved = await realpath(listedPath).catch(() => undefined);
        if (resolved === undefined)
          return lines.some((line) => line.startsWith("locked"))
            ? { unreachableLocked: listedPath }
            : undefined;
        const path = parseAbsolutePath(resolved);
        if (path._tag === "err" || isPathContained(cache, path.value))
          return undefined;
        const branch = parseLocalBranchName(
          lines
            .find((line) => line.startsWith("branch refs/heads/"))
            ?.slice("branch refs/heads/".length),
        );
        return {
          live: {
            path: path.value,
            head:
              branch._tag === "ok"
                ? { kind: "branch", branch: branch.value }
                : { kind: "detached" },
            configured: path.value === configured,
          },
        };
      },
    ),
  );
  return {
    live: read.flatMap((entry) =>
      entry !== undefined && "live" in entry ? [entry.live] : [],
    ),
    unreachableLocked: read.flatMap((entry) =>
      entry !== undefined && "unreachableLocked" in entry
        ? [entry.unreachableLocked]
        : [],
    ),
  };
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
