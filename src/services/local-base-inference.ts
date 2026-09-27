import { definedProps } from "../domain/defined-props";
import {
  parseGitSha,
  parseLocalBranchName,
  type GitSha,
  type LocalBranchName,
} from "../domain/ids";
import { mapConcurrent } from "../domain/map-concurrent";
import { err, ok, type Result } from "../domain/result";
import type { GitReadExecutor } from "./review-worktree-service";

/** The checkout's `HEAD`: the branch it names, or detached. */
type LocalCheckoutHead =
  | { readonly kind: "branch"; readonly branch: LocalBranchName }
  | { readonly kind: "detached" };

/**
 * The base a shared Review takes when none is named (#555): the other local
 * branch whose merge base with `HEAD` has the fewest commits to `HEAD`.
 */
type InferredLocalBase = {
  readonly baseBranch: LocalBranchName;
  /** Commits from the merge base to `HEAD`, the "3 commits back" the dialog shows. */
  readonly commitsBack: number;
};

/** What the Local review dialog offers as a base, and what it preselects. */
export type LocalBranchListing = {
  readonly head: LocalCheckoutHead;
  /** Every local branch but the one `HEAD` names, most recently committed first. */
  readonly branches: ReadonlyArray<LocalBranchName>;
  /** The repository's default branch: `origin/HEAD`, else `init.defaultBranch`, else `main` when that branch exists. */
  readonly defaultBranch?: LocalBranchName;
  /** Absent when no other local branch has a merge base behind `HEAD`. */
  readonly inferred?: InferredLocalBase;
};

export type LocalBranchListingFailure =
  /** `HEAD` has no commit yet. */
  | { readonly _tag: "LocalRevisionNotFound" }
  | { readonly _tag: "LocalGitFailed" };

/** How many branches' merge bases are read at once. */
const MERGE_BASE_CONCURRENCY = 8;

/**
 * Lists the checkout's local branches and infers the nearest base (#555,
 * ADR 0050). A candidate is any other local branch whose tip is not `HEAD`
 * and does not descend from it; ties go to the default branch, then to the
 * most recently committed. Reads refs and commits only.
 */
export async function listLocalBranches(
  git: GitReadExecutor,
  checkoutPath: string,
): Promise<Result<LocalBranchListing, LocalBranchListingFailure>> {
  const read = async (
    ...args: ReadonlyArray<string>
  ): Promise<string | undefined> => {
    const result = await git.run(["git", "-C", checkoutPath, ...args]);
    return result._tag === "ok" ? result.value.stdout : undefined;
  };
  const headSha = parseShaOrUndefined(
    await read("rev-parse", "--verify", "HEAD^{commit}"),
  );
  if (headSha === undefined) return err({ _tag: "LocalRevisionNotFound" });
  const [symbolic, listed] = await Promise.all([
    // `-q` exits nonzero with no output when `HEAD` is detached.
    read("symbolic-ref", "-q", "--short", "HEAD"),
    read(
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:lstrip=2)%00%(objectname)",
      "refs/heads",
    ),
  ]);
  const current =
    symbolic === undefined ? undefined : parseLocalBranchName(symbolic.trim());
  if (current?._tag === "err" || listed === undefined)
    return err({ _tag: "LocalGitFailed" });
  const tips = listed.split("\n").flatMap((line) => {
    const [name, sha] = line.split("\0");
    const branch = parseLocalBranchName(name);
    const tip = parseShaOrUndefined(sha);
    return branch._tag === "ok" &&
      tip !== undefined &&
      branch.value !== current?.value
      ? [{ branch: branch.value, tip }]
      : [];
  });
  const branches = tips.map((candidate) => candidate.branch);
  const [defaultBranch, distances] = await Promise.all([
    readDefaultBranch(
      read,
      current !== undefined && current.value === "main"
        ? [...branches, current.value]
        : branches,
    ),
    mapConcurrent(tips, MERGE_BASE_CONCURRENCY, async ({ branch, tip }) => {
      const mergeBase = parseShaOrUndefined(
        await read("merge-base", "--end-of-options", headSha, tip),
      );
      // Unrelated history, or a tip at or ahead of `HEAD`, is no base.
      if (mergeBase === undefined || mergeBase === headSha) return undefined;
      const count = Number(
        (await read("rev-list", "--count", `${mergeBase}..${headSha}`))?.trim(),
      );
      return Number.isSafeInteger(count) && count > 0
        ? { baseBranch: branch, commitsBack: count }
        : undefined;
    }),
  ]);
  let inferred: InferredLocalBase | undefined;
  for (const candidate of distances) {
    if (candidate === undefined) continue;
    if (
      inferred === undefined ||
      candidate.commitsBack < inferred.commitsBack ||
      (candidate.commitsBack === inferred.commitsBack &&
        candidate.baseBranch === defaultBranch)
    )
      inferred = candidate;
  }
  return ok({
    head:
      current === undefined
        ? { kind: "detached" }
        : { kind: "branch", branch: current.value },
    branches,
    ...definedProps({ defaultBranch, inferred }),
  });
}

/** `origin/HEAD`, else `init.defaultBranch`, else `main` when it is one of `localBranches`. */
async function readDefaultBranch(
  read: (...args: ReadonlyArray<string>) => Promise<string | undefined>,
  localBranches: ReadonlyArray<LocalBranchName>,
): Promise<LocalBranchName | undefined> {
  const remoteHead = (
    await read("symbolic-ref", "-q", "refs/remotes/origin/HEAD")
  )?.trim();
  const remoteName = remoteHead?.replace(/^refs\/remotes\/origin\//, "");
  const named =
    remoteName !== undefined && remoteName !== ""
      ? remoteName
      : (await read("config", "--get", "init.defaultBranch"))?.trim();
  if (named !== undefined && named !== "") {
    const parsed = parseLocalBranchName(named);
    return parsed._tag === "ok" ? parsed.value : undefined;
  }
  return localBranches.find((branch) => branch === "main");
}

function parseShaOrUndefined(value: string | undefined): GitSha | undefined {
  if (value === undefined) return undefined;
  const parsed = parseGitSha(value.trim());
  return parsed._tag === "ok" ? parsed.value : undefined;
}
