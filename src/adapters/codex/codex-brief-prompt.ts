import { BRIEF_RESULT_CONTRACT } from "#src/domain/brief";
import { err, ok, type Result } from "#src/domain/result";
import {
  NATIVE_INSIGHT_PROMPT_BYTES,
  NATIVE_INSIGHT_INSTRUCTIONS,
} from "./codex-insight-policy";
import { UNSAFE_PROMPT_PATTERN } from "./codex-app-server-client";

/** Bounds the composed Brief instructions and captured-evidence reference, without a context bundle. */
export const MAX_BRIEF_PROMPT_BYTES = NATIVE_INSIGHT_PROMPT_BYTES;

/**
 * Builds a sanitized Codex child prompt for a Brief.
 *
 * This lives beside `codex-app-server-client.ts` rather than inside it because
 * that file is 987 lines and the size ratchet freezes any file at 1,000.
 * `buildCodexAnalysisPrompt` and `buildCodexWalkthroughPrompt` are its
 * siblings there; this is the third arm.
 *
 * `briefPrompt` carries the app-owned immutable patch artifact, so the
 * unsafe-content guard applies only to `policy`: applying it to the patch would
 * reject ordinary code such as ` /**`.
 */
export function buildCodexBriefPrompt(input: {
  readonly briefPrompt: string;
  readonly policy: string;
}): Result<string, "invalid_prompt"> {
  if (UNSAFE_PROMPT_PATTERN.test(input.policy)) return err("invalid_prompt");
  const prompt = [
    "Patchdesk owns all Review lifecycle, Finding mapping, publication, and merge authority.",
    "Insight type: brief",
    NATIVE_INSIGHT_INSTRUCTIONS,
    "Return exactly one JSON object. Do not wrap it in a Markdown code fence, and do not add any prose before or after it.",
    BRIEF_RESULT_CONTRACT,
    // The tree, step, depth, and label limits are stated once, by the shared Brief guidance.
    "Use no other keys.",
    input.briefPrompt,
    `Patchdesk policy:\n${input.policy}`,
  ].join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_BRIEF_PROMPT_BYTES)
    return err("invalid_prompt");
  return ok(prompt);
}
