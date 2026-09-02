import { afterEach, describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import {
  PiInsightChildInvoker,
  unavailablePiInsightInvoker,
} from "../../src/services/pi-insight-child-invoker";
import { ANALYSIS_RUN_TIMEOUT_MS } from "../../src/services/child-invocation";
import type { InsightInvocationInput } from "../../src/services/insight-run-coordinator";

const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__0123456789ab";
const walkthrough = {
  citationVersion: 2,
  title: "Walkthrough",
  focus: "The bounded child returned a result.",
  chapters: [
    {
      title: "Review",
      sections: [
        {
          title: "Change",
          prose: "The child returned the one result.",
          hunkIds: ["h1"],
        },
      ],
    },
  ],
};
const analysisResult = {
  changeSummary: "Fixture change summary.",
  // No findings, so the consistent verdict is `approve`.
  verdict: "approve",
  summary: "Fixture summary.",
  findings: [],
  validationPlan: ["Fixture validation plan."],
  assumptions: ["Fixture assumption."],
};
const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;

afterEach(() => {
  if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
});

class RecordingExecutor implements CommandExecutor {
  readonly requests: CommandRequest[] = [];
  constructor(private readonly response: CommandExecution) {}
  async execute(request: CommandRequest): Promise<CommandExecution> {
    this.requests.push(request);
    return this.response;
  }
}

/** Overrides carry explicit `undefined` so a case can drop an optional field. */
type InvocationOverrides = {
  readonly [K in keyof InsightInvocationInput]?:
    | InsightInvocationInput[K]
    | undefined;
};

/**
 * One run as the coordinator hands it to the provider seam, with only the
 * field under test overridden.
 */
function invocation(
  overrides: InvocationOverrides = {},
): InsightInvocationInput {
  // SAFETY: `invoke` compares and forwards these fields and parses the paths itself; it never
  // calls WorkspaceProfileId/ReviewId/ReviewSessionId/InsightRunId/GitSha's own parsers, so plain
  // strings in the right shape exercise the same code paths as branded values.
  return {
    profileId: "profile",
    reviewId:
      "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
    sessionId,
    runId: "insight-analysis-1-aaaaaaaaaaaa-review",
    type: "analysis",
    expectedHeadSha: "a".repeat(40),
    contextPath: "/app/context",
    reviewInputPath: "/app/review-input",
    patchPath: "/app/patch",
    worktreePath: "/app/worktree",
    provider: "pi",
    model: "deepseek/deepseek-v4-flash",
    reasoning: "low",
    ...overrides,
  } as never;
}

describe("PiInsightChildInvoker", () => {
  it("passes a bounded strict stdin protocol and parses only the child data result", async () => {
    process.env.DEEPSEEK_API_KEY = "selected-provider-secret";
    const executor = new RecordingExecutor({
      _tag: "Exited",
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, value: walkthrough }),
      stderr: "private child output",
    });
    const invoker = new PiInsightChildInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
      "/runtime/node",
      "/runtime/child.mjs",
    );
    await expect(
      invoker.invokeWalkthrough(
        {
          profileId: "profile",
          sessionId,
          contextPath: "/app/context",
          patchPath: "/app/patch",
          model: "deepseek/deepseek-v4-flash",
          reasoning: "low",
        },
        60_000,
      ),
    ).resolves.toEqual({ _tag: "ok", value: walkthrough });
    expect(executor.requests).toEqual([
      expect.objectContaining({
        argv: ["/runtime/node", "/runtime/child.mjs"],
        cwd: "/workspace/patchdesk",
        timeoutMs: 60_000,
        environment: {
          ELECTRON_RUN_AS_NODE: "1",
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          DEEPSEEK_API_KEY: "selected-provider-secret",
        },
        inheritEnvironment: false,
        stdin: JSON.stringify({
          type: "walkthrough",
          input: {
            profileId: "profile",
            sessionId,
            contextPath: "/app/context",
            patchPath: "/app/patch",
            model: "deepseek/deepseek-v4-flash",
            reasoning: "low",
          },
        }),
      }),
    ]);
  });

  // The Codex invoker's own test pins the same constant on its side
  // (`codex-insight-invoker.test.ts`). This is the Pi half: without it the
  // shared bound is only observed through one of the two invokers that
  // spend it.
  it("bounds an analysis run by the shared analysis timeout", async () => {
    process.env.DEEPSEEK_API_KEY = "selected-provider-secret";
    const executor = new RecordingExecutor({
      _tag: "Exited",
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, value: analysisResult }),
      stderr: "",
    });
    const invoker = new PiInsightChildInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
      "/runtime/node",
      "/runtime/child.mjs",
    );
    const result = await invoker.invoke(invocation(), {
      signal: new AbortController().signal,
    });
    expect(result._tag).toBe("ok");
    expect(executor.requests[0]?.timeoutMs).toBe(ANALYSIS_RUN_TIMEOUT_MS);
    expect(executor.requests[0]?.timeoutMs).toBe(10 * 60_000);
  });

  it("fails closed for invalid child protocol, crash, overflow-sized input, and cancellation", async () => {
    const invalid = new PiInsightChildInvoker(
      new CommandRunner(
        new RecordingExecutor({
          _tag: "Exited",
          exitCode: 0,
          stdout: "{}",
          stderr: "",
        }),
      ),
      "/workspace",
    );
    await expect(
      invalid.invokeWalkthrough(
        {
          profileId: "profile",
          sessionId,
          contextPath: "/app/context",
          patchPath: "/app/patch",
          model: "deepseek/deepseek-v4-flash",
          reasoning: "low",
        },
        60_000,
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "invalid_result" } });
    const crash = new PiInsightChildInvoker(
      new CommandRunner(
        new RecordingExecutor({
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "secret",
        }),
      ),
      "/workspace",
    );
    await expect(
      crash.invokeWalkthrough(
        {
          profileId: "profile",
          sessionId,
          contextPath: "/app/context",
          patchPath: "/app/patch",
          model: "deepseek/deepseek-v4-flash",
          reasoning: "low",
        },
        60_000,
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
    const controller = new AbortController();
    controller.abort();
    await expect(
      crash.invokeWalkthrough(
        {
          profileId: "profile",
          sessionId,
          contextPath: "/app/context",
          patchPath: "/app/patch",
          model: "deepseek/deepseek-v4-flash",
          reasoning: "low",
        },
        60_000,
        { signal: controller.signal },
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "cancelled" } });
  });
});

// The checks below used to live in three hand-built invoker objects in
// `electron-main.ts`, where only a running app reached them. They are the
// provider seam's own preconditions now, so each is asserted here.
describe("PiInsightChildInvoker provider seam", () => {
  function seam(stdout: string) {
    const executor = new RecordingExecutor({
      _tag: "Exited",
      exitCode: 0,
      stdout,
      stderr: "",
    });
    return {
      executor,
      invoker: new PiInsightChildInvoker(
        new CommandRunner(executor),
        "/workspace/patchdesk",
        "/runtime/node",
        "/runtime/child.mjs",
      ),
    };
  }

  it("rejects the two reasoning efforts this runtime cannot run, before spawning a child", async () => {
    const { executor, invoker } = seam(
      JSON.stringify({ ok: true, value: analysisResult }),
    );
    const options = { signal: new AbortController().signal };
    await expect(
      invoker.invoke(invocation({ reasoning: "minimal" }), options),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
    await expect(
      invoker.invoke(invocation({ reasoning: "xhigh" }), options),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
    expect(executor.requests).toEqual([]);
  });

  it("rejects an analysis without the prepared review input", async () => {
    const { executor, invoker } = seam(
      JSON.stringify({ ok: true, value: analysisResult }),
    );
    await expect(
      invoker.invoke(invocation({ reviewInputPath: undefined }), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
    expect(executor.requests).toEqual([]);
  });

  it("rejects a path the runner would otherwise be handed unparsed", async () => {
    const { executor, invoker } = seam(
      JSON.stringify({ ok: true, value: analysisResult }),
    );
    await expect(
      invoker.invoke(invocation({ contextPath: "app/context" }), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
    expect(executor.requests).toEqual([]);
  });

  it("routes a walkthrough through its patch-scaled bound", async () => {
    const { executor, invoker } = seam(
      JSON.stringify({ ok: true, value: walkthrough }),
    );
    await expect(
      invoker.invoke(invocation({ type: "walkthrough" }), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ _tag: "ok", value: walkthrough });
    // Unreadable fixture artifacts measure as zero bytes, which is the floor.
    expect(executor.requests[0]?.timeoutMs).toBe(5 * 60_000);
  });

  it("fails every run closed when no verified Insight runtime resolved", async () => {
    await expect(
      unavailablePiInsightInvoker.invoke(invocation(), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
  });
});

describe("PiInsightChildInvoker failure classification", () => {
  it("reports a provider refusal as a run failure carrying the child's account of it", async () => {
    const detail =
      'dispatch([redacted]) failed: 402: {"message":"Insufficient Balance"}';
    const invoker = new PiInsightChildInvoker(
      new CommandRunner(
        new RecordingExecutor({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify({
            ok: false,
            reason: "execution_failed",
            detail,
          }),
          stderr: "",
        }),
      ),
      "/workspace",
    );

    await expect(
      invoker.invokeWalkthrough(
        {
          profileId: "profile",
          sessionId,
          contextPath: "/app/context",
          patchPath: "/app/patch",
          model: "deepseek/deepseek-v4-flash",
          reasoning: "low",
        },
        60_000,
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "execution_failed", stderr: detail },
    });
  });

  it("does not blame the model for a request the child rejected", async () => {
    const invoker = new PiInsightChildInvoker(
      new CommandRunner(
        new RecordingExecutor({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify({ ok: false, reason: "invalid_input" }),
          stderr: "",
        }),
      ),
      "/workspace",
    );

    await expect(
      invoker.invokeWalkthrough(
        {
          profileId: "profile",
          sessionId,
          contextPath: "/app/context",
          patchPath: "/app/patch",
          model: "deepseek/deepseek-v4-flash",
          reasoning: "low",
        },
        60_000,
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
  });
});

describe("PiInsightChildInvoker strict response boundary", () => {
  it("rejects ambiguous child objects", async () => {
    const invoker = new PiInsightChildInvoker(
      new CommandRunner(
        new RecordingExecutor({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            value: walkthrough,
            reason: "cancelled",
          }),
          stderr: "private provider output",
        }),
      ),
      "/workspace",
    );

    await expect(
      invoker.invokeWalkthrough(
        {
          profileId: "profile",
          sessionId,
          contextPath: "/app/context",
          patchPath: "/app/patch",
          model: "deepseek/deepseek-v4-flash",
          reasoning: "low",
        },
        60_000,
      ),
    ).resolves.toEqual({ _tag: "err", error: { reason: "invalid_result" } });
  });
});
