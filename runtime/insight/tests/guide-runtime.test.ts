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
import {
  parseReviewSessionId,
  parseWorkspaceProfileId,
  parseReviewId,
  parseInsightRunId,
  parseGitSha,
  parseContentHash,
} from "#app/domain/ids";
import {
  prepareGuidePrompt,
  MAX_GUIDE_PROMPT_BYTES,
} from "#app/services/guide-operation";
import { InsightEvidenceService } from "#app/services/insight-evidence-service";
import { insightEvidenceReference } from "#app/services/insight-evidence-reference";
import { hashReviewArtifactContent } from "#app/services/review-artifact-hash";
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

async function fixture(
  patch = "diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n",
) {
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
    writeFile(patchPath, patch),
  ]);
  const review = parseReviewId(
    "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
  );
  const run = parseInsightRunId("insight-guide-1-aaaaaaaaaaaa-review");
  const head = parseGitSha("a".repeat(40));
  const base = parseGitSha("b".repeat(40));
  const patchHash = parseContentHash(hashReviewArtifactContent(patch));
  if (
    review._tag === "err" ||
    run._tag === "err" ||
    head._tag === "err" ||
    base._tag === "err" ||
    patchHash._tag === "err"
  )
    throw new Error("Invalid fixture identity");
  const captured = await new InsightEvidenceService(paths).prepare({
    identity: {
      profileId,
      sessionId,
      reviewId: review.value,
      runId: run.value,
      type: "guide",
      headSha: head.value,
      baseSha: base.value,
      patchHash: patchHash.value,
      intentHash: null,
    },
    patchPath,
    snapshots: async () => ({}),
  });
  if (captured._tag === "err") throw new Error(captured.error.reason);
  const evidence = insightEvidenceReference(captured.value);
  const prepared = await prepareGuidePrompt({
    contextPath,
    patchPath,
    language: "vi",
    evidence,
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
    evidence,
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
  it("sends a bounded reference request for a valid large captured Guide", async () => {
    const marker = "captured-guide-payload-821";
    const patch =
      "diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,12000 @@\n" +
      Array.from({ length: 12000 }, (_, index) => `+${marker}-${index}\n`).join(
        "",
      );
    const value = await fixture(patch);
    try {
      let prompt = "";
      value.provider.setResponses([
        (context) => {
          prompt = getCurrentSystemPrompt(context.messages);
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
      expect(Buffer.byteLength(patch)).toBeGreaterThan(
        MAX_GUIDE_PROMPT_BYTES * 10,
      );
      expect(value.prepared.patchText).toBe(patch);
      expect(prompt).toContain(
        `EVIDENCE ENTRY: ${value.input.evidence.entryPageId}`,
      );
      expect(prompt).not.toContain(marker);
      expect(prompt).not.toContain("Complete context");
      expect(
        Buffer.byteLength(
          prompt + "Complete the prepared Patchdesk operation.",
        ),
      ).toBeLessThanOrEqual(MAX_GUIDE_PROMPT_BYTES);
      expect(value.provider.state.callCount).toBe(1);
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
      expect(tools).toEqual([
        "submit_patchdesk_result",
        "read_evidence_page",
        "search_evidence",
      ]);
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
      await writeFile(
        join(value.input.evidence.directory, "source-2.txt"),
        "Changed context",
      );
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
