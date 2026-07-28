import { describe, expect, it } from "vitest";

import { CommandRunner, type CommandExecution, type CommandExecutor, type CommandRequest } from "../../src/adapters/github/command-runner";
import {
  FlueCliWalkthroughInvoker,
  type FlueCliWalkthroughInput,
  walkthroughTimeoutMs,
} from "../../src/services/flue-cli-walkthrough-invoker";

const input: FlueCliWalkthroughInput = {
  profileId: "profile-1",
  sessionId: "session-1",
  contextPath: "/app/context.json",
  patchPath: "/app/patch.diff",
  model: "pi-design",
  reasoning: "medium",
};

const validOutput = {
  title: "Recovery walkthrough",
  focus: "Follow the recovery decision from projection to UI.",
  chapters: [{
    title: "Recovery",
    sections: [{
      title: "One next action",
      prose: "The projection selects one action for the maintainer.",
      hunkIds: ["h1"],
    }],
  }],
};

class RecordingExecutor implements CommandExecutor {
  readonly requests: Array<CommandRequest> = [];

  constructor(private readonly response: CommandExecution) {}

  async execute(request: CommandRequest): Promise<CommandExecution> {
    this.requests.push(request);
    return this.response;
  }
}

class ControlledExecutor implements CommandExecutor {
  readonly requests: Array<CommandRequest> = [];
  private resolveResponse: ((response: CommandExecution) => void) | undefined;

  async execute(request: CommandRequest): Promise<CommandExecution> {
    this.requests.push(request);
    return await new Promise<CommandExecution>((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  finish(response: CommandExecution): void {
    this.resolveResponse?.(response);
  }
}

describe("FlueCliWalkthroughInvoker", () => {
  it("scales timeout from artifact size and hunk count with a hard maximum", () => {
    const minimum = walkthroughTimeoutMs({ patchBytes: 0, contextBytes: 0, hunkCount: 0 });
    const larger = walkthroughTimeoutMs({ patchBytes: 512 * 1024, contextBytes: 512 * 1024, hunkCount: 20 });
    const capped = walkthroughTimeoutMs({ patchBytes: 100 * 1024 * 1024, contextBytes: 100 * 1024 * 1024, hunkCount: 100_000 });

    expect(larger).toBeGreaterThan(minimum);
    expect(minimum).toBe(120_000);
    expect(capped).toBe(600_000);
  });

  it("runs the fixed walkthrough command and parses only valid terminal JSON", async () => {
    const executor = new RecordingExecutor({
      _tag: "Exited",
      exitCode: 0,
      stdout: JSON.stringify(validOutput),
      stderr: "private event output",
    });
    const invoker = new FlueCliWalkthroughInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
      "/runtime/node",
      "/runtime/flue.mjs",
      async () => ({ patchBytes: 0, contextBytes: 0, hunkCount: 0 }),
    );

    await expect(invoker.invoke(input)).resolves.toEqual({ _tag: "ok", value: validOutput });
    expect(executor.requests).toEqual([{
      argv: [
        "/runtime/node",
        "/runtime/flue.mjs",
        "run",
        "workflow:generate-walkthrough",
        "--input",
        JSON.stringify(input),
      ],
      cwd: "/workspace/patchdesk",
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      timeoutMs: 120_000,
    }]);
  });

  it("classifies invalid output and command failures without returning model prose", async () => {
    const invalid = new FlueCliWalkthroughInvoker(
      new CommandRunner(new RecordingExecutor({ _tag: "Exited", exitCode: 0, stdout: "not-json", stderr: "model prose" })),
      "/workspace/patchdesk",
    );
    const failed = new FlueCliWalkthroughInvoker(
      new CommandRunner(new RecordingExecutor({ _tag: "Exited", exitCode: 1, stdout: JSON.stringify(validOutput), stderr: "private failure" })),
      "/workspace/patchdesk",
    );

    await expect(invalid.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "invalid_result" } });
    await expect(failed.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
  });

  it("classifies timeout as execution failure", async () => {
    const invoker = new FlueCliWalkthroughInvoker(
      new CommandRunner(new RecordingExecutor({ _tag: "TimedOut", stdout: "", stderr: "" })),
      "/workspace/patchdesk",
    );

    await expect(invoker.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
  });

  it("lets caller cancellation win over a late command failure", async () => {
    const executor = new ControlledExecutor();
    const invoker = new FlueCliWalkthroughInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
      process.execPath,
      "/runtime/flue.mjs",
      async () => ({ patchBytes: 0, contextBytes: 0, hunkCount: 0 }),
    );
    const controller = new AbortController();
    const pending = invoker.invoke(input, { signal: controller.signal });
    await Promise.resolve();

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.signal).toBe(controller.signal);
    controller.abort();
    executor.finish({ _tag: "Exited", exitCode: 1, stdout: "", stderr: "private failure" });

    await expect(pending).resolves.toEqual({ _tag: "err", error: { reason: "cancelled" } });
  });

  it("returns cancellation immediately when the caller already aborted", async () => {
    const executor = new RecordingExecutor({ _tag: "Exited", exitCode: 0, stdout: JSON.stringify(validOutput), stderr: "" });
    const invoker = new FlueCliWalkthroughInvoker(new CommandRunner(executor), "/workspace/patchdesk");
    const controller = new AbortController();
    controller.abort();

    await expect(invoker.invoke(input, { signal: controller.signal })).resolves.toEqual({ _tag: "err", error: { reason: "cancelled" } });
    expect(executor.requests).toHaveLength(0);
  });
});
