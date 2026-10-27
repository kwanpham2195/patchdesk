import { glob, rm } from "node:fs/promises";
import { join } from "node:path";

import { makeInsightEvidenceTreeRemovable } from "#src/adapters/storage/insight-evidence-tree-removal";

/** Test roots own their captures, including the directory modes used by production. */
export async function removeInsightFixtureRoot(root: string): Promise<void> {
  for await (const path of glob("**/prepared/evidence", { cwd: root })) {
    const changed = await makeInsightEvidenceTreeRemovable(
      root,
      join(root, path),
    );
    if (changed._tag === "err")
      throw new Error("Could not release fixture evidence directory");
  }
  await rm(root, { recursive: true, force: true });
}
