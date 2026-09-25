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

/**
 * The first path `git apply` would not write byte for byte, or undefined when
 * every path is written as the patch says. Git converts working-tree output
 * even without `--index`: CRLF line endings, `ident`, smudge filters, and
 * `working-tree-encoding` would move a file off its expected post-image, and
 * the Review would lock at outcome-unknown. Undefined attributes are not
 * errors; a failed attribute read is.
 */
export async function findWorkingTreeConversion(
  git: GitReadExecutor,
  root: string,
  paths: ReadonlyArray<RepoRelativePath>,
): Promise<
  | { readonly _tag: "none" }
  | { readonly _tag: "converts"; readonly path: RepoRelativePath }
  | { readonly _tag: "unreadable" }
> {
  const readConfig = async (name: string) => {
    const read = await git.run([
      "git",
      "-C",
      root,
      "config",
      "--default",
      "",
      "--get",
      name,
    ]);
    return read._tag === "ok"
      ? read.value.stdout.trim().toLowerCase()
      : undefined;
  };
  const [attributes, autocrlf, eol] = await Promise.all([
    git.run([
      "git",
      "-C",
      root,
      "check-attr",
      "-z",
      "eol",
      "text",
      "crlf",
      "ident",
      "filter",
      "working-tree-encoding",
      "--",
      ...paths,
    ]),
    readConfig("core.autocrlf"),
    readConfig("core.eol"),
  ]);
  if (attributes._tag === "err" || autocrlf === undefined || eol === undefined)
    return { _tag: "unreadable" };
  // `-z` prints path, attribute, and value, each ended by NUL.
  const fields = attributes.value.stdout.split("\0");
  const byPath = new Map<string, Map<string, string>>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path = "", attribute = "", info = ""] = fields.slice(
      index,
      index + 3,
    );
    const values = byPath.get(path) ?? new Map<string, string>();
    values.set(attribute, info);
    byPath.set(path, values);
  }
  for (const path of paths) {
    const values = byPath.get(path);
    const valueOf = (attribute: string) =>
      values?.get(attribute) ?? "unspecified";
    const isGiven = (attribute: string) =>
      valueOf(attribute) !== "unspecified" && valueOf(attribute) !== "unset";
    const text = valueOf("text");
    const crlf = valueOf("crlf");
    // Autocrlf treats a file with no `text` attribute as `text=auto`.
    const textual = text !== "unset" && crlf !== "unset";
    const attributedText = text === "set" || text === "auto" || crlf === "set";
    if (
      valueOf("eol") === "crlf" ||
      isGiven("ident") ||
      isGiven("filter") ||
      isGiven("working-tree-encoding") ||
      (autocrlf === "true" && textual) ||
      (eol === "crlf" && attributedText)
    )
      return { _tag: "converts", path };
  }
  return { _tag: "none" };
}
