import { err, ok, type Result } from "#src/domain/result";
import { NATIVE_INSIGHT_INSTRUCTIONS } from "./codex-insight-policy";
import {
  UNSAFE_PROMPT_PATTERN,
  MAX_ANALYSIS_CODEX_PROMPT_BYTES,
} from "./codex-app-server-client";

/** The Analysis result contract Codex must return, kept faithful to modelReviewResultSchema. */
const ANALYSIS_RESULT_CONTRACT = [
  '{"changeSummary":string,"verdict":"approve"|"comment"|"request_changes","summary":string,',
  ' "findings":[{"id":string,"severity":"P0"|"P1"|"P2"|"P3","title":string,"explanation":string,',
  '   "confidence":"high"|"medium"|"low","file"?:string,"lineStart"?:number,"lineEnd"?:number,',
  '   "diffSide"?:"new"|"old","suggestedComment"?:string,',
  '   "category"?:"bug"|"security"|"test"|"performance"|"maintainability"|"docs",',
  '   "suggestedReplacement"?:{"code":string}}],',
  ' "validationPlan":[string],"assumptions":[string],',
  ' "coverage"?:"high"|"medium"|"low","overallConfidence"?:"high"|"medium"|"low",',
  ' "unresolvedItems"?:[string],',
  ' "callouts"?:[{"category":"migration"|"dependency"|"dependency_change"|"authentication"|"compatibility"|"destructive_operation"|"feature_flag"|"configuration","title":string,"detail":string,"path"?:string}]}',
].join("\n");

/**
 * Builds a sanitized Codex child prompt for an Analysis. `analysisPrompt` carries the app-owned
 * immutable patch and context artifacts, so the unsafe-content guard applies only to `policy`:
 * applying it to the patch would reject ordinary code such as ` /**`.
 */
export function buildCodexAnalysisPrompt(input: {
  readonly analysisPrompt: string;
  readonly policy: string;
}): Result<string, "invalid_prompt"> {
  if (UNSAFE_PROMPT_PATTERN.test(input.policy)) return err("invalid_prompt");
  const prompt = [
    "Patchdesk owns all Review lifecycle, Finding mapping, publication, and merge authority.",
    "Insight type: analysis",
    NATIVE_INSIGHT_INSTRUCTIONS,
    "Return exactly one JSON object satisfying the result contract below. Do not wrap it in a Markdown code fence, and do not add any prose before or after it. Use no keys beyond those listed.",
    'The required root is {"outcome":"complete"|"incomplete","result":object|null,"incomplete":object|null}. For complete use the result contract below and null incomplete. For incomplete use null result and {"reason":"insufficient_evidence"|"unable_to_complete","detail":string} with nonblank detail at most 200 characters. All three root fields are required; use no extra fields.',
    "If you cannot complete the review, report an explicit incomplete outcome. Do not submit a partial merge verdict or fabricate a Finding. Low confidence and missing page-read coverage alone do not establish incompleteness.",
    ANALYSIS_RESULT_CONTRACT,
    // The severity and verdict rules are stated once, by the shared Analysis prompt both providers send.
    "Give each finding an id that matches ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ and is unique among the findings.",
    "Give each finding's file a repo-relative path taken from the patch. Never use an absolute path or a path that contains '..'.",
    "Use at most 50 findings. Use at most 20 validationPlan entries and at most 20 assumptions, each within 500 characters. Use at most 10 unresolvedItems, each within 280 characters. Use at most 12 callouts; each callouts entry is an object, never a string, with title within 120 characters and detail within 500 characters.",
    "Give changeSummary, summary, and every finding's title and explanation a non-empty value. Keep changeSummary within 600 characters, summary within 400 characters, each finding's title within 120 characters, and each finding's explanation within 800 characters.",
    input.analysisPrompt,
    `Patchdesk policy:\n${input.policy}`,
  ].join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_ANALYSIS_CODEX_PROMPT_BYTES)
    return err("invalid_prompt");
  return ok(prompt);
}
