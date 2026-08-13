import { afterEach, describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { FlueInsightChildInvoker } from "../../src/services/flue-insight-child-invoker";

const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__0123456789ab";
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

describe("FlueInsightChildInvoker", () => {
  it("passes a bounded strict stdin protocol and parses only the child data result", async () => {
    process.env.DEEPSEEK_API_KEY = "selected-provider-secret";
    const executor = new RecordingExecutor({
      _tag: "Exited",
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, value: walkthrough }),
      stderr: "private child output",
    });
    const invoker = new FlueInsightChildInvoker(
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

  it("fails closed for invalid child protocol, crash, overflow-sized input, and cancellation", async () => {
    const invalid = new FlueInsightChildInvoker(
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
    const crash = new FlueInsightChildInvoker(
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

describe("FlueInsightChildInvoker strict response boundary", () => {
  it("rejects ambiguous child objects", async () => {
    const invoker = new FlueInsightChildInvoker(
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
