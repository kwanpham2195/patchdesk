import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { mapConcurrent } from "../domain/map-concurrent";
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

/** Reads one file's size in bytes without following a symlink; undefined when the file is gone. */
export type UntrackedFileSize = (path: string) => Promise<number | undefined>;

export const lstatFileSize: UntrackedFileSize = async (path) =>
  (await lstat(path).catch(() => undefined))?.size;

/** How many of the largest untracked paths a refusal names. */
const LARGEST_UNTRACKED_PATH_COUNT = 5;
/** On a listing over the output cap, only this many untracked directories are listed again to rank them. */
const RANKED_DIRECTORY_COUNT = 20;
/** Bounds open file handles while 5,000 files are measured. */
const FILE_SIZE_CONCURRENCY = 64;

/** The working tree's untracked files are over the snapshot limits (#485). */
export type UntrackedTooLarge = {
  readonly _tag: "UntrackedTooLarge";
  /** Which of the limits the untracked files are over; the file count wins when both are. */
  readonly exceededLimit: keyof UntrackedLimits;
  /** The outermost untracked directories, or files, holding the most of that limit, largest first, relative to the checkout root. */
  readonly largestPaths: ReadonlyArray<string>;
};

/** A listed untracked path and what it counts toward the exceeded limit. */
type WeightedPath = readonly [path: string, weight: number];

/**
 * Refuses a working tree whose untracked files are over `limits`, before
 * `add -A` hashes any of them. It reads git, and file sizes only when the
 * file count is within its limit. The environment names the snapshot's
 * scratch index, so "untracked" means what `add -A` would add.
 */
export async function checkUntrackedSize(
  git: GitReadExecutor,
  repositoryPath: string,
  environment: Readonly<Record<string, string>>,
  limits: UntrackedLimits,
  fileSize: UntrackedFileSize,
): Promise<
  Result<undefined, UntrackedTooLarge | { readonly _tag: "LocalGitFailed" }>
> {
  const listed = await listUntracked(git, repositoryPath, environment);
  if (listed === undefined) return err({ _tag: "LocalGitFailed" });
  // A listing over the output cap names far more files than `limits.files`.
  if (listed === "over_cap" || listed.length > limits.files)
    return err({
      _tag: "UntrackedTooLarge",
      exceededLimit: "files",
      largestPaths: await largestUntrackedPaths(
        git,
        repositoryPath,
        environment,
        listed === "over_cap"
          ? undefined
          : listed.map((path): WeightedPath => [path, 1]),
      ),
    });
  const sizes = await mapConcurrent(
    listed,
    FILE_SIZE_CONCURRENCY,
    async (path): Promise<WeightedPath> => [
      path,
      // A path removed since the listing adds nothing.
      (await fileSize(join(repositoryPath, path))) ?? 0,
    ],
  );
  if (sizes.reduce((total, [, bytes]) => total + bytes, 0) <= limits.bytes)
    return ok(undefined);
  return err({
    _tag: "UntrackedTooLarge",
    exceededLimit: "bytes",
    largestPaths: await largestUntrackedPaths(
      git,
      repositoryPath,
      environment,
      sizes,
    ),
  });
}

/**
 * The outermost untracked entries with the largest summed weight of the
 * `listed` paths inside them. Without a listing, which was over the output
 * cap, the untracked directories are ranked by how many files they hold.
 */
async function largestUntrackedPaths(
  git: GitReadExecutor,
  repositoryPath: string,
  environment: Readonly<Record<string, string>>,
  listed: ReadonlyArray<WeightedPath> | undefined,
): Promise<ReadonlyArray<string>> {
  // `--directory` collapses a wholly untracked directory to one `dir/` entry, the path to ignore.
  const outermost = await listUntracked(git, repositoryPath, environment, [
    "--directory",
    "--no-empty-directory",
  ]);
  if (outermost === undefined || outermost === "over_cap") return [];
  const ranked =
    listed === undefined
      ? await directoryFileCounts(git, repositoryPath, environment, outermost)
      : weightsByOutermostEntry(new Set(outermost), listed);
  return [...ranked]
    .sort(([, a], [, b]) => b - a || 0)
    .slice(0, LARGEST_UNTRACKED_PATH_COUNT)
    .map(([path]) => path);
}

async function directoryFileCounts(
  git: GitReadExecutor,
  repositoryPath: string,
  environment: Readonly<Record<string, string>>,
  outermost: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, number>> {
  const directories = outermost
    .filter((path) => path.endsWith("/"))
    .slice(0, RANKED_DIRECTORY_COUNT);
  const counted = await Promise.all(
    directories.map(async (directory): Promise<WeightedPath> => {
      const inside = await listUntracked(git, repositoryPath, environment, [
        "--",
        `:(literal)${directory}`,
      ]);
      return [
        directory,
        inside === "over_cap" ? Infinity : (inside?.length ?? 0),
      ];
    }),
  );
  return new Map(counted);
}

function weightsByOutermostEntry(
  entries: ReadonlySet<string>,
  listed: ReadonlyArray<WeightedPath>,
): ReadonlyMap<string, number> {
  const ranked = new Map<string, number>();
  for (const [path, weight] of listed) {
    const entry = outermostEntry(entries, path);
    ranked.set(entry, (ranked.get(entry) ?? 0) + weight);
  }
  return ranked;
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

function outermostEntry(entries: ReadonlySet<string>, path: string): string {
  let end = path.indexOf("/");
  while (end !== -1) {
    const directory = path.slice(0, end + 1);
    if (entries.has(directory)) return directory;
    end = path.indexOf("/", end + 1);
  }
  return path;
}
