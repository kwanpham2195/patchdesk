import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import { isPathContained } from "./path-containment";
import { isNotFound } from "./json-file";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightEvidenceFailure } from "#src/domain/insight-evidence";

/** Rejects symlinks from the owned root through the target; system path aliases are resolved separately. */
export async function evidencePathIsOwned(
  root: string,
  candidate: string,
): Promise<boolean> {
  if (!isPathContained(root, candidate)) return false;
  let current = resolve(candidate);
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch (cause) {
      if (!isNotFound(cause)) return false;
    }
    if (current === resolve(root)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Opens only the expected regular file and compares exact bytes with the parent-held digest. */
export async function readEvidenceFile(input: {
  readonly root: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}): Promise<Result<string, InsightEvidenceFailure>> {
  try {
    if (!(await evidencePathIsOwned(input.root, input.path)))
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_mismatch",
      });
    const root = await realpath(input.root);
    const path = await realpath(input.path);
    if (!isPathContained(root, path))
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_mismatch",
      });
    const file = await open(
      input.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size !== input.bytes)
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_mismatch",
        });
      const bytes = Buffer.alloc(input.bytes + 1);
      let readBytes = 0;
      while (readBytes < bytes.length) {
        const read = await file.read(
          bytes,
          readBytes,
          bytes.length - readBytes,
          readBytes,
        );
        if (read.bytesRead === 0) break;
        readBytes += read.bytesRead;
      }
      const content = bytes.subarray(0, readBytes);
      if (
        readBytes !== input.bytes ||
        createHash("sha256").update(content).digest("hex") !== input.sha256
      )
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_mismatch",
        });
      return ok(content.toString("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    return err({
      _tag: "InsightEvidenceFailure",
      reason: "evidence_unavailable",
    });
  }
}
