import { join } from "node:path";

import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { readEvidenceFile } from "#src/adapters/storage/insight-evidence-validation";
import { NATIVE_INSIGHT_INSTRUCTIONS } from "#src/adapters/codex/codex-insight-policy";
import {
  EVIDENCE_PAGE_BYTES,
  parseEvidencePageId,
  type InsightEvidenceBundle,
  type InsightEvidenceFailure,
} from "#src/domain/insight-evidence";
import { err, ok, type Result } from "#src/domain/result";

/** Native readers start from a separately validated captured entry, not current worktree files. */
export async function accountInsightEvidenceInstructions(
  bundle: InsightEvidenceBundle,
  paths: PatchdeskPaths,
): Promise<Result<string, InsightEvidenceFailure>> {
  const entry = bundle.pages.find((page) => page.id === bundle.entryPageId);
  const identity = bundle.identity;
  if (
    entry === undefined ||
    parseEvidencePageId(entry.id) === undefined ||
    !entry.id.startsWith(`${bundle.bundleId}-p`) ||
    bundle.directory !==
      paths.insightEvidenceDirectory(
        identity.profileId,
        identity.sessionId,
        identity.runId,
      ) ||
    Buffer.byteLength(entry.text) > EVIDENCE_PAGE_BYTES
  )
    return err({ _tag: "InsightEvidenceFailure", reason: "evidence_mismatch" });
  const entryPath = join(bundle.directory, `${entry.id}.ndjson`);
  const checked = await readEvidenceFile({
    root: paths.dataDirectory(),
    path: entryPath,
    sha256: entry.sha256,
    bytes: Buffer.byteLength(entry.text),
  });
  if (checked._tag === "err") return checked;
  return ok(
    [
      NATIVE_INSIGHT_INSTRUCTIONS,
      `Native evidence directory: ${JSON.stringify(bundle.directory)}`,
      `Native evidence entry file: ${JSON.stringify(entryPath)}`,
      "Use native inspection tools to read this NDJSON entry, then the referenced page IDs as files in the same directory with the .ndjson suffix. Follow continuation references as needed. Read complete bounded pages without truncating their contents. Fragment text and original source coordinates are the captured evidence; page line numbers are not source citations.",
    ].join("\n\n"),
  );
}
