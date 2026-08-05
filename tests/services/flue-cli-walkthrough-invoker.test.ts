import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  citationVersion: 2 as const,
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
  it("uses five minutes for empty input and six minutes for a small input", () => {
    expect(walkthroughTimeoutMs({ patchBytes: 0, contextBytes: 0, hunkCount: 0 })).toBe(5 * 60_000);
    expect(walkthroughTimeoutMs({ patchBytes: 1, contextBytes: 1, hunkCount: 0 })).toBe(6 * 60_000);
  });

  it("allocates sixteen minutes for 81 hunks", () => {
    expect(walkthroughTimeoutMs({ patchBytes: 0, contextBytes: 0, hunkCount: 81 })).toBe(16 * 60_000);
  });

  it("adds one minute for each combined 256 KiB byte bucket", () => {
    expect(walkthroughTimeoutMs({ patchBytes: 256 * 1024 - 1, contextBytes: 0, hunkCount: 0 })).toBe(6 * 60_000);
    expect(walkthroughTimeoutMs({ patchBytes: 256 * 1024, contextBytes: 0, hunkCount: 0 })).toBe(6 * 60_000);
    expect(walkthroughTimeoutMs({ patchBytes: 256 * 1024 + 1, contextBytes: 0, hunkCount: 0 })).toBe(7 * 60_000);
  });

  it("caps the timeout at twenty minutes", () => {
    expect(walkthroughTimeoutMs({ patchBytes: 15 * 256 * 1024, contextBytes: 0, hunkCount: 0 })).toBe(20 * 60_000);
  });

  it("derives the timeout from hunk markers in a real patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-"));
    try {
      const patchPath = join(root, "patch.diff");
      const contextPath = join(root, "context.json");
      await writeFile(patchPath, Array.from({ length: 81 }, (_, index) => `@@ -${index + 1},1 +${index + 1},1 @@\n`).join(""), "utf8");
      await writeFile(contextPath, "{}", "utf8");
      const executor = new RecordingExecutor({
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(validOutput),
        stderr: "",
      });
      const invoker = new FlueCliWalkthroughInvoker(
        new CommandRunner(executor),
        root,
        "/runtime/node",
        "/runtime/flue.mjs",
      );

      await expect(invoker.invoke({ ...input, patchPath, contextPath })).resolves.toEqual({ _tag: "ok", value: validOutput });
      expect(executor.requests[0]?.timeoutMs).toBe(16 * 60_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps streamed hunk counting at the maximum timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-cap-"));
    try {
      const patchPath = join(root, "patch.diff");
      const contextPath = join(root, "context.json");
      await writeFile(patchPath, Array.from({ length: 200 }, (_, index) => `@@ -${index + 1},1 +${index + 1},1 @@\n`).join(""), "utf8");
      await writeFile(contextPath, "{}", "utf8");
      const executor = new RecordingExecutor({
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(validOutput),
        stderr: "",
      });
      const invoker = new FlueCliWalkthroughInvoker(new CommandRunner(executor), root, "/runtime/node", "/runtime/flue.mjs");

      await expect(invoker.invoke({ ...input, patchPath, contextPath })).resolves.toEqual({ _tag: "ok", value: validOutput });
      expect(executor.requests[0]?.timeoutMs).toBe(20 * 60_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the minimum timeout when artifact reading fails", async () => {
    const executor = new RecordingExecutor({
      _tag: "Exited",
      exitCode: 0,
      stdout: JSON.stringify(validOutput),
      stderr: "",
    });
    const invoker = new FlueCliWalkthroughInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
      "/runtime/node",
      "/runtime/flue.mjs",
    );

    await expect(invoker.invoke(input)).resolves.toEqual({ _tag: "ok", value: validOutput });
    expect(executor.requests[0]?.timeoutMs).toBe(5 * 60_000);
  });

  it("falls back to the minimum timeout when hunk stream reading fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-stream-error-"));
    try {
      const patchPath = join(root, "patch.diff");
      const contextPath = join(root, "context.json");
      await mkdir(patchPath);
      await writeFile(contextPath, "{}", "utf8");
      const executor = new RecordingExecutor({
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify(validOutput),
        stderr: "",
      });
      const invoker = new FlueCliWalkthroughInvoker(new CommandRunner(executor), root, "/runtime/node", "/runtime/flue.mjs");

      await expect(invoker.invoke({ ...input, patchPath, contextPath })).resolves.toEqual({ _tag: "ok", value: validOutput });
      expect(executor.requests[0]?.timeoutMs).toBe(5 * 60_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      timeoutMs: 5 * 60_000,
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
    await expect(failed.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed", stderr: "private failure" } });
  });

  it("classifies timeout without returning model output", async () => {
    const invoker = new FlueCliWalkthroughInvoker(
      new CommandRunner(new RecordingExecutor({ _tag: "TimedOut", stdout: "", stderr: "" })),
      "/workspace/patchdesk",
    );

    await expect(invoker.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "timed_out" } });
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

  it("returns cancellation when sizing is aborted without invoking the command", async () => {
    const executor = new RecordingExecutor({ _tag: "Exited", exitCode: 0, stdout: JSON.stringify(validOutput), stderr: "" });
    const controller = new AbortController();
    let sizingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sizingStarted = resolve;
    });
    const invoker = new FlueCliWalkthroughInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
      process.execPath,
      "/runtime/flue.mjs",
      async (_input, signal) => {
        sizingStarted();
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { patchBytes: 0, contextBytes: 0, hunkCount: 0 };
      },
    );
    const pending = invoker.invoke(input, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).resolves.toEqual({ _tag: "err", error: { reason: "cancelled" } });
    expect(executor.requests).toHaveLength(0);
  });

  it("returns cancellation when sizing rejects after abort without invoking the command", async () => {
    const executor = new RecordingExecutor({ _tag: "Exited", exitCode: 0, stdout: JSON.stringify(validOutput), stderr: "" });
    const controller = new AbortController();
    let sizingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sizingStarted = resolve;
    });
    const invoker = new FlueCliWalkthroughInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
      process.execPath,
      "/runtime/flue.mjs",
      async (_input, signal) => {
        sizingStarted();
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("stream aborted");
      },
    );
    const pending = invoker.invoke(input, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).resolves.toEqual({ _tag: "err", error: { reason: "cancelled" } });
    expect(executor.requests).toHaveLength(0);
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
