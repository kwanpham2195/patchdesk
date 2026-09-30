import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import {
  updateAgentInstructionsBlock,
  updateMcpToolsBlock,
  updateSkillReviewLoop,
} from "../../scripts/mcp-tools-doc-lib.mjs";
import {
  agentInstructionsBlock,
  reviewLoopInstructions,
} from "../../src/mcp/review-loop-instructions";
import { mcpToolManifest } from "../../src/mcp/tool-manifest";

const readDoc = (path: string): Promise<string> =>
  readFile(resolve(import.meta.dirname, "../..", path), "utf8");

it("lists the tool manifest in docs/mcp.md (run pnpm docs:mcp-tools when this fails)", async () => {
  const document = await readDoc("docs/mcp.md");

  expect(document).toBe(updateMcpToolsBlock(document, mcpToolManifest));
});

it("gives the server's review loop rules as the docs/mcp.md agent block (run pnpm docs:mcp-tools when this fails)", async () => {
  const document = await readDoc("docs/mcp.md");

  expect(document).toBe(
    updateAgentInstructionsBlock(document, agentInstructionsBlock),
  );
});

it("gives the server's review loop in the Patchdesk agent skill (run pnpm docs:mcp-tools when this fails)", async () => {
  const skill = await readDoc("skills/patchdesk/SKILL.md");

  expect(skill).toBe(updateSkillReviewLoop(skill, reviewLoopInstructions));
});
