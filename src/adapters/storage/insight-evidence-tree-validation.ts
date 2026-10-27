import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type {
  InsightEvidenceBundle,
  InsightEvidenceFailure,
} from "#src/domain/insight-evidence";
import { err, ok, type Result } from "#src/domain/result";
import { isPathContained } from "./path-containment";
import {
  evidencePathIsOwned,
  readEvidenceFile,
  validateEvidenceFile,
} from "./insight-evidence-validation";

/** The host index, never manifest.json, determines the exact recursive tree. */
export async function validateInsightEvidenceTree(
  root: string,
  bundle: InsightEvidenceBundle,
  signal?: AbortSignal,
): Promise<Result<void, InsightEvidenceFailure>> {
  const mismatch = {
    _tag: "InsightEvidenceFailure",
    reason: "evidence_mismatch",
  } as const;
  const tree = bundle.tree;
  if (
    tree === undefined ||
    !(await evidencePathIsOwned(root, bundle.directory))
  )
    return err(mismatch);
  const expected = new Map(tree.files.map((file) => [file.name, file]));
  const directories = new Set(tree.directories);
  if (
    expected.size !== tree.files.length ||
    directories.size !== tree.directories.length ||
    [...expected.keys()].some((name) => directories.has(name))
  )
    return err(mismatch);
  const foundFiles = new Set<string>();
  const foundDirectories = new Set<string>();
  const visit = async (relative: string): Promise<boolean> => {
    if (signal?.aborted) return false;
    const path = join(bundle.directory, relative);
    if (
      !isPathContained(bundle.directory, path) ||
      !(await evidencePathIsOwned(root, path))
    )
      return false;
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    for (const name of await readdir(path)) {
      const child = relative === "" ? name : `${relative}/${name}`;
      const childPath = join(bundle.directory, child);
      if (!isPathContained(bundle.directory, childPath)) return false;
      const entry = await lstat(childPath);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!directories.has(child)) return false;
        foundDirectories.add(child);
        if (!(await visit(child))) return false;
      } else {
        const file = expected.get(child);
        if (
          file === undefined ||
          !entry.isFile() ||
          (entry.mode & 0o777) !== 0o444
        )
          return false;
        const checked = await validateEvidenceFile({
          root,
          path: childPath,
          ...file,
        });
        if (checked._tag === "err") return false;
        foundFiles.add(child);
      }
    }
    return true;
  };
  try {
    if (
      !(await visit("")) ||
      foundFiles.size !== expected.size ||
      foundDirectories.size !== directories.size
    )
      return err(mismatch);
    const patchHash = createHash("sha256");
    for (const name of tree.diffs) {
      const file = expected.get(name);
      if (file === undefined || !name.startsWith("diff/") || signal?.aborted)
        return err(mismatch);
      const read = await readEvidenceFile({
        root,
        path: join(bundle.directory, name),
        ...file,
      });
      if (read._tag === "err") return read;
      patchHash.update(read.value);
    }
    return patchHash.digest("hex") === bundle.identity.patchHash
      ? ok(undefined)
      : err(mismatch);
  } catch {
    return err({
      _tag: "InsightEvidenceFailure",
      reason: "evidence_unavailable",
    });
  }
}
