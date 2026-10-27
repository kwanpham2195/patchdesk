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
      `Read the entry with this complete shell command, preserving both enclosing quotes: cat -- '${entryPath.replaceAll("'", "'\\''")}'`,
      "Use native inspection tools to read this NDJSON entry, then the referenced page IDs as files in the same directory with the .ndjson suffix. Read at most one captured page per native tool call. Each page is at most 32 KiB. If the tool accepts an output limit, such as `max_output_tokens`, request 10000 for every page read; a smaller value cuts the page off.",
      "A shell syntax error is not a permission refusal. Correct mismatched quotes and reread the same captured page. A native permission refusal remains authoritative; do not bypass it.",
      "If page output is truncated, reread that same page in consecutive physical NDJSON line ranges, starting at its first line with one bounded record per call, for example sed -n 'N,Np' <captured-page>. Emit plain ranges without line-number decoration. Track the next unread physical line and finish every intervening record, including the continuation record, before following the continuation.",
      "If a record itself is truncated, read contiguous UTF-8-safe subranges of that same record. Subdivide further on actual truncation or omission warnings until every part is complete; never skip the middle. If complete delivery cannot be obtained, report incomplete evidence, not partial success. Fragment text and original source coordinates are the captured evidence; physical page line numbers are read cursors, not source citations.",
    ].join("\n\n"),
  );
}
