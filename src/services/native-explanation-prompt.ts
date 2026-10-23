import type { InsightEvidenceBundle } from "#src/domain/insight-evidence";
import type { InsightLanguage } from "#src/domain/insight-provider";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { err, ok, type Result } from "#src/domain/result";
import { accountInsightEvidenceInstructions } from "./account-insight-evidence";
import { insightEvidenceReference } from "./insight-evidence-reference";
import { composeGuideSessionPrompt } from "./guide-operation";
import { composeWalkthroughSessionPrompt } from "./walkthrough-session-prompt";

/** Native text has no output schema or submission suffix; accepted finish freezes the receipts. */
export async function composeNativeExplanationPrompt(
  kind: "guide" | "walkthrough",
  evidence: InsightEvidenceBundle,
  language: InsightLanguage,
  paths: PatchdeskPaths,
): Promise<
  Result<
    string,
    "evidence_unavailable" | "evidence_mismatch" | "prompt_too_large"
  >
> {
  const native = await accountInsightEvidenceInstructions(evidence, paths);
  if (native._tag === "err")
    return err(
      native.error.reason === "evidence_mismatch"
        ? "evidence_mismatch"
        : "evidence_unavailable",
    );
  const reference = insightEvidenceReference(evidence);
  const initial =
    kind === "guide"
      ? composeGuideSessionPrompt(reference, language, "native")
      : composeWalkthroughSessionPrompt(reference, language);
  const prompt = [
    initial,
    native.value,
    "Accepted finish freezes writing; Patchdesk validates later; do not return a final JSON result.",
  ].join("\n\n");
  return Buffer.byteLength(prompt, "utf8") <= 65536
    ? ok(prompt)
    : err("prompt_too_large");
}
