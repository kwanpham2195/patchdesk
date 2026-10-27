import { InsightEvidenceStore } from "#src/adapters/storage/insight-evidence-store";
import { analysisEvidencePrompt } from "./insight-evidence-reference";

import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { NATIVE_INSIGHT_INSTRUCTIONS } from "#src/adapters/codex/codex-insight-policy";
import {
  type InsightEvidenceBundle,
  type InsightEvidenceFailure,
} from "#src/domain/insight-evidence";
import { err, ok, type Result } from "#src/domain/result";

/** Native readers start from a separately validated captured entry, not current worktree files. */
export async function accountInsightEvidenceInstructions(
  bundle: InsightEvidenceBundle,
  paths: PatchdeskPaths,
): Promise<Result<string, InsightEvidenceFailure>> {
  if (bundle.tree === undefined)
    return err({ _tag: "InsightEvidenceFailure", reason: "evidence_mismatch" });
  const checked = await new InsightEvidenceStore(paths).validate(bundle);
  if (checked._tag === "err") return checked;
  return ok(
    [
      NATIVE_INSIGHT_INSTRUCTIONS,
      analysisEvidencePrompt(bundle.directory),
    ].join("\n\n"),
  );
}
