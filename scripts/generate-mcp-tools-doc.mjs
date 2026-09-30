#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { agentInstructionsBlock } from "../src/mcp/review-loop-instructions.ts";
import { mcpToolManifest } from "../src/mcp/tool-manifest.ts";
import {
  updateAgentInstructionsBlock,
  updateMcpToolsBlock,
} from "./mcp-tools-doc-lib.mjs";

// Rewrites the tools reference and the agent instructions block in docs/mcp.md; tests/scripts/mcp-tools-doc.test.ts fails `pnpm check` when it is stale.
const documentPath = resolve(import.meta.dirname, "../docs/mcp.md");
const document = await readFile(documentPath, "utf8");
await writeFile(
  documentPath,
  updateAgentInstructionsBlock(
    updateMcpToolsBlock(document, mcpToolManifest),
    agentInstructionsBlock,
  ),
);
console.log(
  `Wrote the tools reference and agent instructions in ${documentPath}`,
);
