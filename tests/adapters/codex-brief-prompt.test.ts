import { describe, expect, it } from "vitest";

import {
  buildCodexBriefPrompt,
  MAX_BRIEF_PROMPT_BYTES,
} from "../../src/adapters/codex/codex-brief-prompt";

describe("buildCodexBriefPrompt", () => {
  const briefPrompt = [
    "HUNK ALIAS MANIFEST:",
    "h1 | src/adapters/codex/codex-app-server-client.ts | @@ -1,3 +1,4 @@",
    "PATCH ARTIFACT:",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    "+/**",
    "+ * Reads /etc/passwd for demonstration only, never executed.",
    "+ */",
  ].join("\n");

  it("does not apply the unsafe-content guard to the brief prompt, and includes the shape block and the flow limits", () => {
    const result = buildCodexBriefPrompt({
      briefPrompt,
      policy: "Read only the represented review revision.",
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value).toContain(briefPrompt);
    expect(result.value).toContain("HUNK ALIAS MANIFEST");
    expect(result.value).toContain(
      '"flow":[{"kind":"call_tree"|"control_flow"|"component","title":string',
    );
    expect(result.value).toContain(
      "Use at most 3 flow trees, one per kind, at most 15 steps per tree, at most 3 levels deep, and labels within 120 characters.",
    );
  });

  it("still rejects an unsafe policy", () => {
    expect(
      buildCodexBriefPrompt({
        briefPrompt,
        policy: "Read /etc/passwd",
      }),
    ).toEqual({ _tag: "err", error: "invalid_prompt" });
  });

  it("rejects an over-size composed prompt", () => {
    const oversized = "x".repeat(MAX_BRIEF_PROMPT_BYTES);
    expect(
      buildCodexBriefPrompt({
        briefPrompt: oversized,
        policy: "Read only.",
      }),
    ).toEqual({ _tag: "err", error: "invalid_prompt" });
  });
});
