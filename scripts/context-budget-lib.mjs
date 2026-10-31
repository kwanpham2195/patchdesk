import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { toJsonSchema } from "@valibot/to-json-schema";

export const BUDGET_FILE = "context-budget.json";

/** Matches a message line `context-increase: <reason>` with a nonblank reason. */
const INCREASE_TRAILER = /^context-increase:[ \t]*\S/m;

const LANGUAGE = "en";

// Fixed lengths only: the stub fills the evidence-reference slots of the
// composed prompts, so their sizes do not drift with real hashes.
const STUB_EVIDENCE = {
  identity: {
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    patchHash: "c".repeat(64),
  },
  bundleId: "d".repeat(64),
  directory: "/evidence",
};

/**
 * @param {string} text
 * @returns {number}
 */
const bytes = (text) => Buffer.byteLength(text, "utf8");

/**
 * Bytes of the text a model receives, one entry per item. Builders that take
 * run inputs are measured with empty or fixed stub inputs, so an entry covers
 * the static template, not a particular run's evidence:
 * - `*_output_guidance`: `insightOutputGuidance` for one Insight type, English.
 * - `review_prompt`, `walkthrough_session_prompt`, `guide_session_prompt`:
 *   the composers, with a stub evidence reference.
 * - `codex_analysis_prompt`, `codex_brief_prompt`: the Codex wrapper with empty
 *   `analysisPrompt`/`briefPrompt` and policy.
 * - `pi_explanation_prompt`: the Pi helper template with empty arguments.
 * - `local_draft_agent_prompt`: the prompt for a Review with no drafts.
 * - `mcp_tools`: name, description and JSON Schema of every tool, serialized.
 * - `mcp_instructions`: the text the MCP server sends at connect.
 * - `agents_md`: AGENTS.md.
 * The Brief prompt composed in `brief-operation.ts` reads patch files, so only
 * its guidance (`brief_output_guidance`) is measured.
 *
 * @param {(path: string) => Promise<any>} load Loads a TypeScript module by repo-relative path.
 * @param {string} root
 * @returns {Promise<Record<string, number>>}
 */
export async function measureContextBudget(load, root) {
  const guidance = await load("src/domain/insight-output-guidance.ts");
  const review = await load("src/services/review-rubric.ts");
  const walkthrough = await load("src/services/walkthrough-session-prompt.ts");
  const guide = await load("src/services/guide-operation.ts");
  const native = await load("src/services/native-explanation-prompt.ts");
  const analysis = await load("src/adapters/codex/codex-analysis-prompt.ts");
  const brief = await load("src/adapters/codex/codex-brief-prompt.ts");
  const draft = await load("src/domain/local-draft-agent-prompt.ts");
  const manifest = await load("src/mcp/tool-manifest.ts");
  const loop = await load("src/mcp/review-loop-instructions.ts");

  const codexPrompt = (/** @type {any} */ result) => {
    if (result._tag !== "ok")
      throw new Error("A Codex prompt did not build from empty inputs.");
    return result.value;
  };
  const tools = Object.entries(manifest.mcpToolManifest).map(
    ([name, tool]) => ({
      name,
      description: /** @type {any} */ (tool).description,
      inputSchema: toJsonSchema(/** @type {any} */ (tool).inputSchema),
    }),
  );
  const piPrompt = native.composePiExplanationPrompt("", "", "", []);
  if (piPrompt._tag !== "ok")
    throw new Error("The Pi explanation prompt did not build.");

  /** @type {Record<string, string>} */
  const text = {
    analysis_output_guidance: guidance.insightOutputGuidance(
      "analysis",
      LANGUAGE,
    ),
    walkthrough_output_guidance: guidance.insightOutputGuidance(
      "walkthrough",
      LANGUAGE,
    ),
    brief_output_guidance: guidance.insightOutputGuidance("brief", LANGUAGE),
    guide_output_guidance: guidance.insightOutputGuidance("guide", LANGUAGE),
    review_prompt: review.composeReviewPrompt({
      evidence: STUB_EVIDENCE,
      language: LANGUAGE,
    }),
    walkthrough_session_prompt: walkthrough.composeWalkthroughSessionPrompt(
      STUB_EVIDENCE,
      LANGUAGE,
    ),
    guide_session_prompt: guide.composeGuideSessionPrompt(
      STUB_EVIDENCE,
      LANGUAGE,
    ),
    codex_analysis_prompt: codexPrompt(
      analysis.buildCodexAnalysisPrompt({ analysisPrompt: "", policy: "" }),
    ),
    codex_brief_prompt: codexPrompt(
      brief.buildCodexBriefPrompt({ briefPrompt: "", policy: "" }),
    ),
    pi_explanation_prompt: piPrompt.value,
    local_draft_agent_prompt: draft.renderLocalDraftsAsAgentPrompt([]),
    mcp_tools: JSON.stringify(tools),
    mcp_instructions: loop.reviewLoopInstructions,
    agents_md: await readFile(resolve(root, "AGENTS.md"), "utf8"),
  };
  return Object.fromEntries(
    Object.entries(text).map(([name, value]) => [name, bytes(value)]),
  );
}

/**
 * @param {Readonly<Record<string, number>>} budget
 * @returns {string}
 */
export function renderBudget(budget) {
  return `${JSON.stringify(budget, null, 2)}\n`;
}

/**
 * Entries whose measured size is above the budget; a missing entry counts as 0.
 *
 * @param {Readonly<Record<string, number>>} budget
 * @param {Readonly<Record<string, number>>} measured
 * @returns {ReadonlyArray<string>} One line per grown entry.
 */
export function findGrowth(budget, measured) {
  return Object.entries(measured)
    .filter(([name, size]) => size > (budget[name] ?? 0))
    .map(
      ([name, size]) =>
        `${name}: ${String(budget[name] ?? 0)} -> ${String(size)} bytes`,
    );
}

/**
 * @param {string} message
 * @returns {boolean}
 */
export function hasIncreaseTrailer(message) {
  return INCREASE_TRAILER.test(message);
}
