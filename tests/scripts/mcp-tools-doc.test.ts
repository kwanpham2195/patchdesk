import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { updateMcpToolsBlock } from "../../scripts/mcp-tools-doc-lib.mjs";
import { mcpToolManifest } from "../../src/mcp/tool-manifest";

const readDoc = (path: string): Promise<string> =>
  readFile(resolve(import.meta.dirname, "../..", path), "utf8");

it("lists the tool manifest in docs/mcp.md (run pnpm docs:mcp-tools when this fails)", async () => {
  const document = await readDoc("docs/mcp.md");

  expect(document).toBe(updateMcpToolsBlock(document, mcpToolManifest));
});

it("gives the same agent instructions in README.md and docs/mcp.md", async () => {
  // README.md nests the block in a numbered step, so compare it without its indent.
  const agentBlock = (document: string): string | undefined => {
    const found =
      /^( *)```markdown\n\1## Review in Patchdesk\n[\s\S]*?\n\1```/m.exec(
        document,
      );
    return found?.[0]
      .split("\n")
      .map((line) => line.slice(found[1]?.length))
      .join("\n");
  };

  const fromReadme = agentBlock(await readDoc("README.md"));

  expect(fromReadme).toBeDefined();
  expect(agentBlock(await readDoc("docs/mcp.md"))).toBe(fromReadme);
});
