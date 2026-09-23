import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareBriefPrompt } from "../../src/services/brief-operation";

const PATCH = [
  "diff --git a/src/recovery.ts b/src/recovery.ts",
  "--- a/src/recovery.ts",
  "+++ b/src/recovery.ts",
  "@@ -1,2 +1,3 @@",
  " const before = true;",
  "+const after = true;",
  "",
].join("\n");

async function briefPromptResult(patch: string | Buffer) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-brief-prompt-"));
  try {
    const patchPath = join(root, "patch.diff");
    await writeFile(patchPath, patch);
    return await prepareBriefPrompt({ patchPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function briefPrompt(): Promise<string> {
  const prepared = await briefPromptResult(PATCH);
  if (prepared._tag === "err")
    throw new Error(
      `brief prompt preparation failed: ${prepared.error.reason}`,
    );
  return prepared.value;
}

describe("prepareBriefPrompt", () => {
  it("asks for the reach symbols the schema accepts, stated once", async () => {
    const prompt = await briefPrompt();
    expect(prompt).toContain(
      "List in reachSymbols up to 24 exported functions, types, or constants",
    );
    expect(prompt).not.toContain("12 exported functions");
    expect(prompt.split("reachSymbols up to")).toHaveLength(2);
  });

  it("includes the shared Flow tree limits in the Brief prompt", async () => {
    const prompt = await briefPrompt();
    expect(prompt).toContain("Give at most 3 flow trees, one for each kind.");
    expect(prompt).toContain(
      "Keep each tree at most 3 levels deep and at most 15 steps.",
    );
    expect(prompt).toContain("Keep each label within 120 characters.");
  });

  it("sends no provenance identifiers, which the model has no use for", async () => {
    const prompt = await briefPrompt();
    expect(prompt).not.toContain("provenance");
    expect(prompt).not.toContain("Profile ");
    expect(prompt).not.toContain("do not repeat them in prose");
  });

  it("returns patch_too_large for a patch past the bounded input size", async () => {
    await expect(
      briefPromptResult(Buffer.alloc(2 * 1024 * 1024 + 1, 0x78)),
    ).resolves.toEqual({ _tag: "err", error: { reason: "patch_too_large" } });
  });
});
