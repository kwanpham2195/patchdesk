import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";

import { canonicalPatchFlags } from "../adapters/process/git-patch-flags";
import { parseContentHash, type ContentHash, type GitSha } from "../domain/ids";
import { localSnapshotUntrackedLimits } from "./local-untracked-size";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { GitReadExecutor } from "./review-worktree-service";

/** `hash-object` takes its paths as arguments, so a long untracked listing is hashed in batches. */
const HASH_OBJECT_BATCH_SIZE = 500;

/**
 * Runs every git read with `--no-optional-locks`, so a read never refreshes
 * the index and never takes `index.lock` from the maintainer or an agent.
 */
export function withoutOptionalLocks(git: GitReadExecutor): GitReadExecutor {
  return {
    run: (argv, environment) =>
      git.run(["git", "--no-optional-locks", ...argv.slice(1)], environment),
  };
}

/**
 * A read-only fingerprint of a shared Review's checkout (#611, ADR 0050
 * "Freshness"): `headSha`, the merge base, the working tree's `git diff`
 * against `headSha`, and each untracked file's blob hash. Unlike the Local
 * snapshot it writes no object, so it can run on every update check, and it
 * changes on a second edit to an already modified file. A diff over the git
 * output cap, or more untracked files than a snapshot takes, is recorded as
 * such rather than read, so Refresh reports the refusal. Undefined when git
 * cannot read the checkout.
 */
export async function fingerprintLocalCheckout(
  git: GitReadExecutor,
  checkoutPath: string,
  revision: { readonly headSha: GitSha; readonly mergeBase: GitSha },
): Promise<ContentHash | undefined> {
  const reads = withoutOptionalLocks(git);
  const [diff, untracked] = await Promise.all([
    reads.run([
      "git",
      "-C",
      checkoutPath,
      "diff",
      "--binary",
      ...canonicalPatchFlags,
      revision.headSha,
      "--",
    ]),
    reads.run([
      "git",
      "-C",
      checkoutPath,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  if (diff._tag === "err" && diff.error._tag !== "GitReadOutputExceeded")
    return undefined;
  if (
    untracked._tag === "err" &&
    untracked.error._tag !== "GitReadOutputExceeded"
  )
    return undefined;
  const untrackedPaths =
    untracked._tag === "ok"
      ? untracked.value.stdout.split("\0").filter((path) => path !== "")
      : undefined;
  const untrackedEntries =
    untrackedPaths === undefined ||
    untrackedPaths.length > localSnapshotUntrackedLimits.files
      ? ["untracked-over-limit"]
      : await hashUntracked(reads, checkoutPath, untrackedPaths);
  if (untrackedEntries === undefined) return undefined;
  const parsed = parseContentHash(
    hashReviewArtifactContent(
      [
        revision.headSha,
        revision.mergeBase,
        diff._tag === "ok"
          ? hashReviewArtifactContent(diff.value.stdout)
          : "diff-over-limit",
        ...untrackedEntries,
      ].join("\0"),
    ),
  );
  return parsed._tag === "ok" ? parsed.value : undefined;
}

/**
 * Each untracked path and its content. `hash-object` without `-w` reads only
 * regular files, so the rest get a marker: a symlink its link text, a
 * directory, which `ls-files` lists for a nested repository, that
 * repository's `HEAD` as `add -A` records it, and a path removed since the
 * listing `missing`.
 */
async function hashUntracked(
  git: GitReadExecutor,
  checkoutPath: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<string> | undefined> {
  const kinds = await Promise.all(
    paths.map(async (path) => ({
      path,
      content: await untrackedMarker(git, join(checkoutPath, path)),
    })),
  );
  const files = kinds.flatMap((kind) =>
    kind.content === undefined ? [kind.path] : [],
  );
  const hashes = new Map<string, string>();
  for (let start = 0; start < files.length; start += HASH_OBJECT_BATCH_SIZE) {
    const batch = files.slice(start, start + HASH_OBJECT_BATCH_SIZE);
    const hashed = await hashFiles(git, checkoutPath, batch);
    // One file removed since the listing fails the whole batch, so each is hashed alone to find it.
    const read =
      hashed ??
      (await Promise.all(
        batch.map(async (path) => {
          const hash = (await hashFiles(git, checkoutPath, [path]))?.[0];
          if (hash !== undefined) return hash;
          const gone = await lstat(join(checkoutPath, path)).then(
            () => false,
            () => true,
          );
          return gone ? "missing" : undefined;
        }),
      ));
    for (const [index, path] of batch.entries()) {
      const hash = read[index];
      if (hash === undefined) return undefined;
      hashes.set(path, hash);
    }
  }
  return kinds.map(
    (kind) => `${kind.path}\0${kind.content ?? hashes.get(kind.path) ?? ""}`,
  );
}

/** The marker for an untracked path `hash-object` cannot read; undefined for a regular file. */
async function untrackedMarker(
  git: GitReadExecutor,
  absolute: string,
): Promise<string | undefined> {
  const stats = await lstat(absolute).catch(() => undefined);
  if (stats === undefined) return "missing";
  if (stats.isFile()) return undefined;
  if (stats.isSymbolicLink())
    return `link:${(await readlink(absolute).catch(() => undefined)) ?? "missing"}`;
  if (stats.isDirectory()) {
    const head = await git.run([
      "git",
      "-C",
      absolute,
      "rev-parse",
      "--verify",
      "-q",
      "HEAD",
    ]);
    return head._tag === "ok"
      ? `repository:${head.value.stdout.trim()}`
      : "directory";
  }
  // A FIFO or socket: `hash-object` would block on or refuse it.
  return "special";
}

/** One `hash-object` line per path, in order; undefined when git refuses any of them. */
async function hashFiles(
  git: GitReadExecutor,
  checkoutPath: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<string> | undefined> {
  const hashed = await git.run([
    "git",
    "-C",
    checkoutPath,
    "hash-object",
    "--no-filters",
    "--",
    ...paths,
  ]);
  if (hashed._tag === "err") return undefined;
  const lines = hashed.value.stdout.split("\n").slice(0, paths.length);
  return lines.length === paths.length && lines.every((line) => line !== "")
    ? lines
    : undefined;
}
