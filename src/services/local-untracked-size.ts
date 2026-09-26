import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, type Result } from "../domain/result";
import type { GitReadExecutor } from "./review-worktree-service";

export type UntrackedLimits = {
  readonly files: number;
  readonly bytes: number;
};

/**
 * `add -A` hashes every untracked file into the maintainer's object store
 * under the 15 s git timeout, and 20,000 small files took 4.8 s (#485), so
 * these keep an ordinary snapshot well inside it and refuse an un-ignored
 * dependency or build directory before any blob is written.
 */
export const localSnapshotUntrackedLimits: UntrackedLimits = {
  files: 5_000,
  bytes: 100 * 1024 * 1024,
};

/** How many of the largest untracked paths a refusal names. */
const LARGEST_UNTRACKED_PATH_COUNT = 5;
/** On a listing over the output cap, only this many untracked directories are listed again to rank them. */
const RANKED_DIRECTORY_COUNT = 20;

/** The working tree's untracked files are over the snapshot limits (#485). */
export type UntrackedTooLarge = {
  readonly _tag: "UntrackedTooLarge";
  /** The outermost untracked directories, or files, holding the most, largest first, relative to the checkout root. */
  readonly largestPaths: ReadonlyArray<string>;
};

type UntrackedSize = { readonly files: number; readonly bytes: number };

/**
 * Refuses a working tree whose untracked files are over `limits`, before
 * `add -A` hashes any of them. It reads git and file sizes only. The
 * environment names the snapshot's scratch index, so "untracked" means what
 * `add -A` would add.
 */
export async function checkUntrackedSize(
  git: GitReadExecutor,
  repositoryPath: string,
  environment: Readonly<Record<string, string>>,
  limits: UntrackedLimits,
): Promise<
  Result<undefined, UntrackedTooLarge | { readonly _tag: "LocalGitFailed" }>
> {
  const listed = await listUntracked(git, repositoryPath, environment);
  if (listed === undefined) return err({ _tag: "LocalGitFailed" });
  // A listing over the output cap names far more files than `limits.files`.
  const sizes =
    listed === "over_cap" || listed.length > limits.files
      ? undefined
      : await measureFiles(repositoryPath, listed);
  if (sizes !== undefined) {
    const total = sumSizes([...sizes.values()]);
    if (total.files <= limits.files && total.bytes <= limits.bytes)
      return ok(undefined);
  }
  const overFiles = sizes === undefined || sizes.size > limits.files;
  return err({
    _tag: "UntrackedTooLarge",
    largestPaths: await largestUntrackedPaths(
      git,
      repositoryPath,
      environment,
      listed === "over_cap" ? undefined : listed,
      overFiles ? "files" : "bytes",
    ),
  });
}

/** The outermost untracked entries, ranked by the limit the tree is over. */
async function largestUntrackedPaths(
  git: GitReadExecutor,
  repositoryPath: string,
  environment: Readonly<Record<string, string>>,
  files: ReadonlyArray<string> | undefined,
  rankBy: keyof UntrackedSize,
): Promise<ReadonlyArray<string>> {
  // `--directory` collapses a wholly untracked directory to one `dir/` entry, the path to ignore.
  const outermost = await listUntracked(git, repositoryPath, environment, [
    "--directory",
    "--no-empty-directory",
  ]);
  if (outermost === undefined || outermost === "over_cap") return [];
  const ranked = new Map<string, UntrackedSize>();
  if (files === undefined) {
    const directories = outermost
      .filter((path) => path.endsWith("/"))
      .slice(0, RANKED_DIRECTORY_COUNT);
    const measured = await Promise.all(
      directories.map(async (directory) => {
        const inside = await listUntracked(git, repositoryPath, environment, [
          "--",
          `:(literal)${directory}`,
        ]);
        if (inside === "over_cap")
          return [directory, { files: Infinity, bytes: Infinity }] as const;
        const sizes =
          inside === undefined
            ? []
            : [...(await measureFiles(repositoryPath, inside)).values()];
        return [directory, sumSizes(sizes)] as const;
      }),
    );
    for (const [directory, size] of measured) ranked.set(directory, size);
  } else {
    const entries = new Set(outermost);
    const sizes = await measureFiles(repositoryPath, files);
    for (const [path, size] of sizes) {
      const entry = outermostEntry(entries, path);
      ranked.set(entry, sumSizes([ranked.get(entry) ?? noSize, size]));
    }
  }
  return [...ranked]
    .sort(([, a], [, b]) => b[rankBy] - a[rankBy] || 0)
    .slice(0, LARGEST_UNTRACKED_PATH_COUNT)
    .map(([path]) => path);
}

async function listUntracked(
  git: GitReadExecutor,
  repositoryPath: string,
  environment: Readonly<Record<string, string>>,
  options: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<string> | "over_cap" | undefined> {
  const listed = await git.run(
    [
      "git",
      "-C",
      repositoryPath,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...options,
    ],
    environment,
  );
  if (listed._tag === "ok")
    return listed.value.stdout.split("\0").filter((path) => path !== "");
  return listed.error._tag === "GitReadOutputExceeded" ? "over_cap" : undefined;
}

/** Each path's size; a path removed since the listing counts as one empty file. */
async function measureFiles(
  repositoryPath: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, UntrackedSize>> {
  const sizes = await Promise.all(
    paths.map(async (path) => {
      const stats = await lstat(join(repositoryPath, path)).catch(
        () => undefined,
      );
      return [path, { files: 1, bytes: stats?.size ?? 0 }] as const;
    }),
  );
  return new Map(sizes);
}

function outermostEntry(entries: ReadonlySet<string>, path: string): string {
  let end = path.indexOf("/");
  while (end !== -1) {
    const directory = path.slice(0, end + 1);
    if (entries.has(directory)) return directory;
    end = path.indexOf("/", end + 1);
  }
  return path;
}

const noSize: UntrackedSize = { files: 0, bytes: 0 };

function sumSizes(sizes: ReadonlyArray<UntrackedSize>): UntrackedSize {
  return sizes.reduce(
    (total, size) => ({
      files: total.files + size.files,
      bytes: total.bytes + size.bytes,
    }),
    noSize,
  );
}
