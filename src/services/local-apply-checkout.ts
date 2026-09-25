import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { isPathContained } from "../adapters/storage/path-containment";
import {
  parseContentHash,
  type ContentHash,
  type RepoRelativePath,
} from "../domain/ids";
import type { GitReadExecutor } from "./review-worktree-service";

/**
 * The checkout's top-level directory with symlinks resolved. Session patch
 * paths are relative to it whatever subdirectory the profile's `localPath` names.
 */
export async function resolveCheckoutRoot(
  git: GitReadExecutor,
  localPath: string,
): Promise<string | undefined> {
  const top = await git.run([
    "git",
    "-C",
    localPath,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (top._tag === "err") return undefined;
  return realpath(top.value.stdout.trim()).catch(() => undefined);
}

/**
 * A regular file's bytes, read only when `path` stays inside `root` and no
 * component of it is a symlink: the resolved path must be the joined path
 * itself. Undefined for anything else, including a missing file.
 */
export async function readCheckoutFile(
  root: string,
  path: RepoRelativePath,
): Promise<Buffer | undefined> {
  const candidate = join(root, path);
  try {
    const resolved = await realpath(candidate);
    if (resolved !== candidate || !isPathContained(root, resolved))
      return undefined;
    if (!(await lstat(resolved)).isFile()) return undefined;
    return await readFile(resolved);
  } catch {
    return undefined;
  }
}

/** The sha256 an Apply records for a file's exact bytes. */
export function hashFileBytes(bytes: Uint8Array): ContentHash | undefined {
  const hash = parseContentHash(
    createHash("sha256").update(bytes).digest("hex"),
  );
  return hash._tag === "ok" ? hash.value : undefined;
}
