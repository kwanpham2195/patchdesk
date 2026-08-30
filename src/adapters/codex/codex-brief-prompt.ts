import { BRIEF_RESULT_CONTRACT } from "../../domain/brief";
import { err, ok, type Result } from "../../domain/result";
import { UNSAFE_PROMPT_PATTERN } from "./codex-app-server-client";

/** Hard bound for one composed Brief prompt; a Brief carries the patch but no context bundle. */
export const MAX_BRIEF_PROMPT_BYTES = 3 * 1024 * 1024;

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
    "The represented review worktree is immutable and read-only. Do not modify files, access credentials, use network, or request permission escalation.",
    "Return exactly one JSON object. Do not wrap it in a Markdown code fence, and do not add any prose before or after it.",
    BRIEF_RESULT_CONTRACT,
    "Use no other keys. Use at most 8 goal items and at most 12 assumptions, each within 400 characters, and at most 8 citations per goal item.",
    input.briefPrompt,
    `Patchdesk policy:\n${input.policy}`,
  ].join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_BRIEF_PROMPT_BYTES)
    return err("invalid_prompt");
  return ok(prompt);
}
