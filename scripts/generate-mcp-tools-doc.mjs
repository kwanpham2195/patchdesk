#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  agentInstructionsBlock,
  reviewLoopInstructions,
} from "../src/mcp/review-loop-instructions.ts";
import { mcpToolManifest } from "../src/mcp/tool-manifest.ts";
import {
  updateAgentInstructionsBlock,
  updateMcpToolsBlock,
  updateSkillReviewLoop,
} from "./mcp-tools-doc-lib.mjs";

// Rewrites the tools reference and the agent instructions block in docs/mcp.md, and the review loop in the Patchdesk agent skill; tests/scripts/mcp-tools-doc.test.ts fails `pnpm check` when either is stale.
const documentPath = resolve(import.meta.dirname, "../docs/mcp.md");
const document = await readFile(documentPath, "utf8");
await writeFile(
  documentPath,
  updateAgentInstructionsBlock(
    updateMcpToolsBlock(document, mcpToolManifest),
    agentInstructionsBlock,
  ),
);
const skillPath = resolve(import.meta.dirname, "../skills/patchdesk/SKILL.md");
const skill = await readFile(skillPath, "utf8");
await writeFile(
  skillPath,
  updateSkillReviewLoop(skill, reviewLoopInstructions),
);
console.log(
  `Wrote the tools reference and agent instructions in ${documentPath}, and the review loop in ${skillPath}`,
);
