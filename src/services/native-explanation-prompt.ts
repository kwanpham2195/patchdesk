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

/** Pi's Bash helper submits only the selected existing logical-operation declarations. */
export function composePiExplanationPrompt(
  base: string,
  launcher: string,
  helper: string,
  declarations: ReadonlyArray<{
    readonly name: string;
    readonly inputSchema: object;
  }>,
): Result<string, "prompt_too_large"> {
  const shellQuote = (value: string): string =>
    "'" + value.replaceAll("'", "'\\''") + "'";
  const prompt =
    base +
    "\n\n" +
    `Submit Patchdesk operations through the Bash helper below. Send one JSON object on stdin with exactly tool and input. The operation schemas below define the allowed tool names and input fields. Do not add run, generation, connection, paths or authentication fields.

ELECTRON_RUN_AS_NODE=1 ${shellQuote(launcher)} ${shellQuote(helper)} <<'PATCHDESK_CALL'
{"tool":"<operation>","input":{<fields matching that operation schema>}}
PATCHDESK_CALL

Use small batches. If the helper refuses an oversized call, split its batch without changing accepted operations. Wait for each receipt before submitting the next operation. Use the group, chapter and section IDs returned by Patchdesk. Give every mutation a unique opId and reuse it only with identical arguments. If a submitted operation has no confirmed receipt, use lookup_receipt for that same opId before deciding what happened. Do not resend a mutation under a new opId to resolve uncertainty. Stop if the helper reports unknown execution or closes the connection.

Call finish through this helper after all intended operations are accepted. A helper exit code or final assistant message cannot publish a result. Do not print environment variables or attempt other result-submission paths.

Operation schemas:
${JSON.stringify(declarations)}`;
  return Buffer.byteLength(prompt) <= 65536
    ? ok(prompt)
    : err("prompt_too_large");
}
