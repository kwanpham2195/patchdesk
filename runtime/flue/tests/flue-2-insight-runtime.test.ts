import { PassThrough, Readable } from "node:stream";
import { generateModelCatalog } from "../scripts/generate-model-catalog.mjs";
import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";

import { PatchdeskPaths } from "../../../src/adapters/storage/patchdesk-paths";
import {
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../../src/domain/ids";
import { ReviewInspector } from "../../../src/services/review-inspector";

import {
  createAnalysisAgent,
  createWalkthroughAgent,
  modelReviewResultSchema,
  walkthroughResultSchema,
} from "../src/patchdesk-insight-agent";
import {
  canonicalizeProductionInvocation,
  resolvePatchdeskReviewSkillPath,
  runPatchdeskChild,
  runPatchdeskChildProcess,
} from "../src/patchdesk-insight-runner";

const walkthrough = {
  citationVersion: 2,
  title: "Walkthrough",
  focus: "The patch adds a bounded review path.",
  chapters: [
    {
      title: "Review",
      sections: [
        {
          title: "One change",
          prose: "The child accepts one result.",
          hunkIds: ["h1"],
        },
      ],
    },
  ],
};
const analysis = {
  changeSummary: "One change.",
  verdict: "approve",
  summary: "No findings.",
  findings: [],
  validationPlan: [],
  assumptions: [],
};

describe("generated Pi catalog", () => {
  it("imports and projects all 32 current allowlisted provider catalogs deterministically", () => {
    const first = generateModelCatalog();
    expect(first).toEqual(generateModelCatalog());
    expect(first.piVersion).toBe("0.84.1");
    expect(first.catalog).toHaveLength(32);
    expect(
      first.catalog
        .flatMap((entry) => entry.models)
        .every(
          (model) => Object.keys(model).sort().join(",") === "id,name,provider",
        ),
    ).toBe(true);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});

function walkthroughInvocation() {
  return {
    type: "walkthrough" as const,
    input: {
      profileId: "profile",
      sessionId: "session",
      contextPath: "/immutable/context",
      patchPath: "/immutable/patch",
      model: "faux/test",
      reasoning: "low" as const,
      prompt: "Submit one result.",
    },
  };
}

function analysisInvocation() {
  return {
    type: "analysis" as const,
    input: {
      profileId: "profile",
      sessionId: "session",
      contextPath: "/immutable/context",
      reviewInputPath: "/immutable/input",
      patchPath: "/immutable/patch",
      worktreePath: "/immutable/worktree",
      model: "faux/test",
      reasoning: "low" as const,
      prompt: "Inspect then submit one result.",
    },
  };
}

function fake(responses: ReadonlyArray<FauxResponseStep>) {
  const provider = fauxProvider({ provider: "faux", models: [{ id: "test" }] });
  provider.setResponses([...responses]);
  return provider;
}

const canonicalSessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__0123456789ab";

describe("Flue 2 one-shot insight runtime", () => {
  it("uses start/init/dispatch/read and returns one strict data value without parsing prose", async () => {
    const provider = fake([
      fauxAssistantMessage(
        [
          fauxText("untrusted prose"),
          fauxToolCall("submit_patchdesk_result", walkthrough),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    await expect(
      runPatchdeskChild(walkthroughInvocation(), {
        providers: [provider.provider],
      }),
    ).resolves.toEqual({ ok: true, value: walkthrough });
    expect(provider.state.callCount).toBe(1);
  });

  it("rejects missing and extra data rather than treating assistant text as authority", async () => {
    const provider = fake([
      fauxAssistantMessage(fauxText(JSON.stringify(walkthrough))),
    ]);
    await expect(
      runPatchdeskChild(walkthroughInvocation(), {
        providers: [provider.provider],
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_result" });
    const malformed = fake([
      fauxAssistantMessage(
        fauxToolCall("submit_patchdesk_result", {
          ...walkthrough,
          extra: true,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("Unable to submit a valid result.")),
    ]);
    await expect(
      runPatchdeskChild(walkthroughInvocation(), {
        providers: [malformed.provider],
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_result" });
  });

  it("resolves the trusted skill from the direct development bundle", () => {
    expect(resolvePatchdeskReviewSkillPath()).toBe(
      new URL(
        "../../../src/skills/patchdesk-code-review/SKILL.md",
        import.meta.url,
      ).pathname,
    );
  });

  it("rejects duplicate submission attempts after recording only the first data part", async () => {
    const provider = fake([
      fauxAssistantMessage(
        [
          fauxToolCall("submit_patchdesk_result", walkthrough),
          fauxToolCall("submit_patchdesk_result", walkthrough),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    await expect(
      runPatchdeskChild(walkthroughInvocation(), {
        providers: [provider.provider],
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_result" });
  });

  it("gives Analysis exactly four bounded inspectors plus submission and preserves one shared budget", async () => {
    const tools = createAnalysisAgent(
      analysisInvocation().input,
      {
        async listChangedFiles() {
          return { files: ["src/a.ts"] };
        },
        async searchFiles() {
          return { files: [] };
        },
        async readFileRange() {
          return { content: "const a = 1;" };
        },
        async gitShow() {
          return { content: "commit" };
        },
      },
      {
        name: "patchdesk-code-review",
        description: "Review",
        instructions: "Review safely.",
      },
    );
    expect(tools.agent).toBeTypeOf("function");
    expect(modelReviewResultSchema).toBeDefined();
    expect(walkthroughResultSchema).toBeDefined();
    const provider = fake([
      fauxAssistantMessage(fauxToolCall("list_changed_files", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("submit_patchdesk_result", analysis), {
        stopReason: "toolUse",
      }),
    ]);
    await expect(
      runPatchdeskChild(analysisInvocation(), {
        providers: [provider.provider],
        inspectors: {
          async listChangedFiles() {
            return { files: ["src/a.ts"] };
          },
          async searchFiles() {
            return { files: [] };
          },
          async readFileRange() {
            return { content: "const a = 1;" };
          },
          async gitShow() {
            return { content: "commit" };
          },
        },
        skillPath: new URL(
          "../../../src/skills/patchdesk-code-review/SKILL.md",
          import.meta.url,
        ).pathname,
      }),
    ).resolves.toEqual({ ok: true, value: analysis });
    expect(provider.state.callCount).toBe(2);
  });

  it("settles a submission plus inspector batch in one model turn and retains only the submitted result", async () => {
    const provider = fake([
      fauxAssistantMessage(
        [
          fauxToolCall("submit_patchdesk_result", analysis),
          fauxToolCall("list_changed_files", {}),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    await expect(
      runPatchdeskChild(analysisInvocation(), {
        providers: [provider.provider],
        inspectors: {
          async listChangedFiles() {
            return { files: ["src/a.ts"] };
          },
          async searchFiles() {
            return { files: [] };
          },
          async readFileRange() {
            return { content: "" };
          },
          async gitShow() {
            return { content: "" };
          },
        },
        skillPath: new URL(
          "../../../src/skills/patchdesk-code-review/SKILL.md",
          import.meta.url,
        ).pathname,
      }),
    ).resolves.toEqual({ ok: true, value: analysis });
    expect(provider.state.callCount).toBe(1);
  });

  it("requests a durable abort through the agent handle when the caller cancels", async () => {
    const provider = fake([
      fauxAssistantMessage(
        fauxToolCall("submit_patchdesk_result", walkthrough),
        { stopReason: "toolUse" },
      ),
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runPatchdeskChild(walkthroughInvocation(), {
        providers: [provider.provider],
        signal: controller.signal,
      }),
    ).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(provider.state.callCount).toBe(0);
  });

  it("aborts a running handle and discards a late provider result", async () => {
    const provider = fake([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return fauxAssistantMessage(
          fauxToolCall("submit_patchdesk_result", walkthrough),
          { stopReason: "toolUse" },
        );
      },
    ]);
    const controller = new AbortController();
    let abortHandle: (() => Promise<void>) | undefined;
    let abortRequests = 0;
    const pending = runPatchdeskChild(walkthroughInvocation(), {
      providers: [provider.provider],
      signal: controller.signal,
      onHandle: (abort) => {
        abortHandle = abort;
      },
      onAbortRequested: () => {
        abortRequests += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (abortHandle === undefined) throw new Error("expected running handle");
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(abortRequests).toBe(1);
    expect(provider.state.callCount).toBe(1);
  });

  it("exposes only the allowed model-visible tool catalogs", async () => {
    let walkthroughTools: ReadonlyArray<string> = [];
    const walkthroughProvider = fake([
      (context) => {
        walkthroughTools = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage(
          fauxToolCall("submit_patchdesk_result", walkthrough),
          { stopReason: "toolUse" },
        );
      },
    ]);
    await expect(
      runPatchdeskChild(walkthroughInvocation(), {
        providers: [walkthroughProvider.provider],
      }),
    ).resolves.toEqual({ ok: true, value: walkthrough });
    expect(walkthroughTools).toEqual(["task", "submit_patchdesk_result"]);

    let analysisTools: ReadonlyArray<string> = [];
    const analysisProvider = fake([
      (context) => {
        analysisTools = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage(
          fauxToolCall("submit_patchdesk_result", analysis),
          { stopReason: "toolUse" },
        );
      },
    ]);
    await expect(
      runPatchdeskChild(analysisInvocation(), {
        providers: [analysisProvider.provider],
        inspectors: {
          async listChangedFiles() {
            return { files: [] };
          },
          async searchFiles() {
            return { files: [] };
          },
          async readFileRange() {
            return { denied: true };
          },
          async gitShow() {
            return { denied: true };
          },
        },
        skillPath: new URL(
          "../../../src/skills/patchdesk-code-review/SKILL.md",
          import.meta.url,
        ).pathname,
      }),
    ).resolves.toEqual({ ok: true, value: analysis });
    expect(analysisTools).toEqual([
      "task",
      "activate_skill",
      "submit_patchdesk_result",
      "list_changed_files",
      "search_files",
      "read_file_range",
      "git_show",
    ]);
    expect(analysisTools).not.toEqual(
      expect.arrayContaining([
        "bash",
        "read",
        "write",
        "edit",
        "mcp",
        "github",
      ]),
    );
  });

  it("keeps one real inspector budget across turns and denies concurrent call nine", async () => {
    const inspector = new ReviewInspector({
      worktreePath: "/immutable/worktree",
      changedFiles: ["src/a.ts"],
      fileSnapshots: { "src/a.ts": "export const a = 1;\n" },
      async gitShow() {
        return "";
      },
    });
    const observed: Array<
      { readonly files: Array<string> } | { readonly denied: true }
    > = [];
    const inspectors = {
      async listChangedFiles() {
        const result = await inspector.listChangedFiles();
        const output =
          result._tag === "ok"
            ? { files: [...result.value] }
            : { denied: true as const };
        observed.push(output);
        return output;
      },
      async searchFiles() {
        return { files: [] };
      },
      async readFileRange() {
        return { denied: true as const };
      },
      async gitShow() {
        return { denied: true as const };
      },
    };
    const firstBatch = Array.from({ length: 4 }, () =>
      fauxToolCall("list_changed_files", {}),
    );
    const secondBatch = Array.from({ length: 5 }, () =>
      fauxToolCall("list_changed_files", {}),
    );
    const provider = fake([
      fauxAssistantMessage(firstBatch, { stopReason: "toolUse" }),
      fauxAssistantMessage(secondBatch, { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("submit_patchdesk_result", analysis), {
        stopReason: "toolUse",
      }),
    ]);
    await expect(
      runPatchdeskChild(analysisInvocation(), {
        providers: [provider.provider],
        inspectors,
        skillPath: new URL(
          "../../../src/skills/patchdesk-code-review/SKILL.md",
          import.meta.url,
        ).pathname,
      }),
    ).resolves.toEqual({ ok: true, value: analysis });
    expect(provider.state.callCount).toBe(3);
    expect(observed).toHaveLength(9);
    expect(observed.filter((value) => "denied" in value)).toHaveLength(1);
    expect(observed.at(-1)).toEqual({ denied: true });
  });

  it("accepts only exact app-owned production paths", () => {
    const paths = PatchdeskPaths.forTest("/tmp/patchdesk-flue-paths");
    const parsedProfile = parseWorkspaceProfileId("profile");
    const parsedSession = parseReviewSessionId(canonicalSessionId);
    if (parsedProfile._tag === "err" || parsedSession._tag === "err") {
      throw new Error("fixture identity is invalid");
    }
    const input = {
      profileId: parsedProfile.value,
      sessionId: parsedSession.value,
      contextPath: paths.preparedContextFile(
        parsedProfile.value,
        parsedSession.value,
      ),
      reviewInputPath: paths.preparedReviewInputFile(
        parsedProfile.value,
        parsedSession.value,
      ),
      patchPath: paths.patchFile(parsedProfile.value, parsedSession.value),
      worktreePath: paths.worktreeDirectory(
        parsedProfile.value,
        parsedSession.value,
      ),
      model: "faux/test",
      reasoning: "low" as const,
    };
    expect(
      canonicalizeProductionInvocation({ type: "analysis", input }, paths),
    ).toMatchObject({ type: "analysis", input });
    expect(
      canonicalizeProductionInvocation(
        {
          type: "analysis",
          input: { ...input, patchPath: "/tmp/foreign.diff" },
        },
        paths,
      ),
    ).toBeUndefined();
  });

  it("does not add a sandbox, MCP connection, declared subagent, or inspector tool to Walkthrough", () => {
    const created = createWalkthroughAgent(walkthroughInvocation().input);
    expect(created.agent).toBeTypeOf("function");
    expect(created.capabilities).toEqual({
      customTools: ["submit_patchdesk_result"],
      usesSkill: false,
      usesSandbox: false,
      usesMcp: false,
      usesSubagent: false,
    });
  });

  it("declares only the four Analysis inspectors and submission capability", () => {
    const created = createAnalysisAgent(
      analysisInvocation().input,
      {
        async listChangedFiles() {
          return { files: [] };
        },
        async searchFiles() {
          return { files: [] };
        },
        async readFileRange() {
          return { denied: true };
        },
        async gitShow() {
          return { denied: true };
        },
      },
      {
        name: "patchdesk-code-review",
        description: "Review",
        instructions: "Review safely.",
      },
    );
    expect(created.capabilities).toEqual({
      customTools: [
        "list_changed_files",
        "search_files",
        "read_file_range",
        "git_show",
        "submit_patchdesk_result",
      ],
      usesSkill: true,
      usesSandbox: false,
      usesMcp: false,
      usesSubagent: false,
    });
  });

  it("rejects malformed and oversized process stdin before a runtime starts", async () => {
    const malformedOutput = new PassThrough();
    let malformedText = "";
    malformedOutput.setEncoding("utf8");
    malformedOutput.on("data", (chunk: string) => {
      malformedText += chunk;
    });
    await runPatchdeskChildProcess(
      Readable.from([Buffer.from("not-json")]),
      malformedOutput,
    );
    expect(malformedText).toBe(
      JSON.stringify({ ok: false, reason: "invalid_input" }),
    );

    const oversizedOutput = new PassThrough();
    let oversizedText = "";
    oversizedOutput.setEncoding("utf8");
    oversizedOutput.on("data", (chunk: string) => {
      oversizedText += chunk;
    });
    await runPatchdeskChildProcess(
      Readable.from([Buffer.from("x".repeat(2 * 1024 * 1024 + 1))]),
      oversizedOutput,
    );
    expect(oversizedText).toBe(
      JSON.stringify({ ok: false, reason: "invalid_input" }),
    );
  });
});
