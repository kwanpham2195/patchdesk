import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, type Result } from "#src/domain/result";
import { evidencePathIsOwned } from "./insight-evidence-validation";
import { isNotFound, type StorageFailure } from "./json-file";

/** Only a caller already authorized to remove this tree may restore directory write permission. */
export async function makeInsightEvidenceTreeRemovable(
  root: string,
  directory: string,
): Promise<Result<void, StorageFailure>> {
  try {
    if (!(await evidencePathIsOwned(root, directory)))
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory())
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "io",
        });
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "io",
        });
      if (!entry.isDirectory()) continue;
      const changed = await makeInsightEvidenceTreeRemovable(
        root,
        join(directory, entry.name),
      );
      if (changed._tag === "err") return changed;
    }
    return ok(undefined);
  } catch (cause) {
    return isNotFound(cause)
      ? ok(undefined)
      : err({ _tag: "StorageFailure", operation: "write", reason: "io" });
  }
}
