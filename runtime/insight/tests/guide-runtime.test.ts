import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { PatchdeskPaths } from "#app/adapters/storage/patchdesk-paths";
import { parseReviewSessionId, parseWorkspaceProfileId } from "#app/domain/ids";
import {
  prepareGuidePrompt,
  MAX_GUIDE_PROMPT_BYTES,
} from "#app/services/guide-operation";
import { createGuideAgent } from "#runtime/src/patchdesk-insight-agent";
import {
  parseProductionInvocation,
  runProductionChild,
  runPatchdeskChild,
} from "#runtime/src/patchdesk-insight-runner";

const result = {
  groups: [
    {
      title: "Guard",
      explanation: "Adds a guard.",
      files: [{ fileId: "f1", relevance: "Owns the guard." }],
    },
  ],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-guide-runtime-"));
  const paths = PatchdeskPaths.forTest(root);
  const profile = parseWorkspaceProfileId("profile");
  const session = parseReviewSessionId(
    "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__0123456789ab",
  );
  if (profile._tag === "err" || session._tag === "err")
    throw new Error("Invalid identity");
  const profileId = profile.value;
  const sessionId = session.value;
  await mkdir(paths.sessionDirectory(profileId, sessionId), {
    recursive: true,
  });
  const contextPath = paths.preparedContextFile(profileId, sessionId);
  const patchPath = paths.patchFile(profileId, sessionId);
  await mkdir(dirname(contextPath), { recursive: true });
  await Promise.all([
    writeFile(contextPath, "Complete context"),
    writeFile(
      patchPath,
      "diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n",
    ),
  ]);
  const prepared = await prepareGuidePrompt({
    contextPath,
    patchPath,
    language: "vi",
  });
  if (prepared._tag === "err") throw new Error("Invalid evidence");
  const input = {
    profileId,
    sessionId,
    contextPath,
    patchPath,
    model: "faux/test",
    reasoning: "low" as const,
    language: "vi" as const,
    expectedPromptHash: createHash("sha256")
      .update(prepared.value.prompt)
      .digest("hex"),
  };
  const provider = fauxProvider({ provider: "faux", models: [{ id: "test" }] });
  return { root, paths, input, prepared: prepared.value, provider };
}

describe("Guide runtime contract", () => {
  it("classifies a residual transport size refusal before provider invocation", async () => {
    const value = await fixture();
    try {
      const outcome = await runPatchdeskChild(
        {
          type: "guide",
          input: {
            ...value.input,
            prompt: "x".repeat(MAX_GUIDE_PROMPT_BYTES - 1),
          },
        },
        { providers: [value.provider.provider] },
      );
      expect(outcome).toEqual({
        ok: false,
        reason: "invalid_input",
        detail: "prompt_too_large",
      });
      expect(value.provider.state.callCount).toBe(0);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
  it("reserves submission bytes in production preparation before invoking a provider", async () => {
    const value = await fixture();
    try {
      const header = "diff --git a/a.ts b/a.ts\n";
      const metadata = "z".repeat(512 * 1024 - 500) + "\n";
      const hunk = "@@ -0,0 +1 @@\n+";
      const patch =
        header +
        metadata +
        hunk +
        "x".repeat(
          2 * 1024 * 1024 - header.length - metadata.length - hunk.length,
        );
      await writeFile(value.input.patchPath, patch);
      await writeFile(value.input.contextPath, "");
      const base = await prepareGuidePrompt(value.input);
      if (base._tag === "err") throw new Error("Invalid bounded workload");
      const contextBytes =
        MAX_GUIDE_PROMPT_BYTES - Buffer.byteLength(base.value.prompt) - 1;
      expect(contextBytes).toBeLessThanOrEqual(512 * 1024);
      await writeFile(value.input.contextPath, "c".repeat(contextBytes));
      expect(
        await runProductionChild(
          { type: "guide", input: value.input },
          new AbortController().signal,
          {
            paths: value.paths,
            providers: [value.provider.provider],
            onHandle: () => undefined,
          },
        ),
      ).toEqual({
        ok: false,
        reason: "invalid_input",
        detail: "prompt_too_large",
      });
      expect(value.provider.state.callCount).toBe(0);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("uses the same complete task prompt and adds exactly one submission tool", async () => {
    const value = await fixture();
    try {
      let prompt = "";
      let tools: string[] = [];
      value.provider.setResponses([
        (context) => {
          prompt = getCurrentSystemPrompt(context.messages);
          tools = getCurrentTools(context.messages).map((tool) => tool.name);
          return fauxAssistantMessage(
            fauxToolCall("submit_patchdesk_result", result),
            { stopReason: "toolUse" },
          );
        },
      ]);
      expect(
        await runProductionChild(
          { type: "guide", input: value.input },
          new AbortController().signal,
          {
            paths: value.paths,
            providers: [value.provider.provider],
            onHandle: () => undefined,
          },
        ),
      ).toEqual({ ok: true, value: result });
      expect(prompt).toBe(
        `${value.prepared.prompt}\n\nSubmit exactly one result with submit_patchdesk_result and do not provide an independent answer.`,
      );
      expect(tools).toEqual(["submit_patchdesk_result"]);
      expect(value.provider.state.callCount).toBe(1);
      expect(
        parseProductionInvocation({
          type: "guide",
          input: { ...value.input, prompt: "Foreign prompt" },
        }),
      ).toBeUndefined();
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
  it("refuses changed complete evidence before invoking the provider", async () => {
    const value = await fixture();
    try {
      await writeFile(value.input.contextPath, "Changed context");
      expect(
        await runProductionChild(
          { type: "guide", input: value.input },
          new AbortController().signal,
          {
            paths: value.paths,
            providers: [value.provider.provider],
            onHandle: () => undefined,
          },
        ),
      ).toMatchObject({ ok: false });
      expect(value.provider.state.callCount).toBe(0);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
  it("bounds the final runtime prompt including submission instructions", () => {
    expect(() =>
      createGuideAgent({
        profileId: "profile",
        sessionId: "session",
        contextPath: "/context",
        patchPath: "/patch",
        model: "faux/test",
        reasoning: "low",
        prompt: "x".repeat(MAX_GUIDE_PROMPT_BYTES),
      }),
    ).toThrow("prompt_too_large");
  });
});
