import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  PI_CLI_MINIMUM_VERSION,
  PiRpcClient,
} from "../../src/adapters/pi-cli/pi-rpc-client";
import type { RepresentedReviewWorktree } from "../../src/domain/represented-review-worktree";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };
type JsonRecord = { readonly [key: string]: JsonValue };
type Spawned = {
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnOptions;
};

/** One scripted `pi` child: `--version` prints a version, `--mode rpc` answers commands. */
class FakePiProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<JsonRecord> = [];

  constructor(
    private readonly answer: (
      command: JsonRecord,
      write: (record: JsonRecord) => void,
    ) => void,
  ) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // SAFETY: the client under test writes one JSON object per line, built from strings and booleans.
        const command = JSON.parse(line) as JsonRecord;
        this.received.push(command);
        this.answer(command, (record) => this.write(record));
      }
    });
  }

  write(record: JsonRecord): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  kill(): boolean {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

/**
 * The ChildProcess surface the pi client reads: the three pipes, kill(), and
 * once()/on() listeners. `once` returns `void` so any EventEmitter satisfies it.
 */
type ChildProcessSurface = {
  readonly stdin: ChildProcess["stdin"];
  readonly stdout: ChildProcess["stdout"];
  readonly stderr: ChildProcess["stderr"];
  kill(): boolean;
  once(event: string, listener: (...args: unknown[]) => void): void;
};

function asChildProcess(fake: FakePiProcess): ChildProcess {
  const surface: ChildProcessSurface = fake;
  // SAFETY: the pi client only reads the three pipes, calls kill(), and listens for "error", "exit", and "close"; FakePiProcess provides exactly that surface.
  return surface as ChildProcess;
}

type RpcScript = (
  command: JsonRecord,
  write: (record: JsonRecord) => void,
  child: FakePiProcess,
) => void;

function fakePi(options: {
  readonly version?: string;
  readonly rpc: RpcScript;
}) {
  const spawned: Array<Spawned> = [];
  const children: Array<FakePiProcess> = [];
  const processFactory = (
    _file: string,
    args: ReadonlyArray<string>,
    spawnOptions: SpawnOptions,
  ): ChildProcess => {
    spawned.push({ args, options: spawnOptions });
    if (args[0] === "--version") {
      const versionChild = new FakePiProcess(() => undefined);
      setImmediate(() => {
        versionChild.stdout.write(`${options.version ?? "0.87.1"}\n`);
        setImmediate(() => versionChild.emit("close", 0, null));
      });
      return asChildProcess(versionChild);
    }
    const child: FakePiProcess = new FakePiProcess((command, write) =>
      options.rpc(command, write, child),
    );
    children.push(child);
    return asChildProcess(child);
  };
  return { spawned, children, processFactory };
}

const worktree = "/tmp/patchdesk-worktree" as RepresentedReviewWorktree;
const runInput = {
  worktreePath: worktree,
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
  prompt: "Return the Brief as JSON.",
} as const;

function respond(command: JsonRecord, fields: JsonRecord = {}) {
  return {
    type: "response",
    id: command.id ?? null,
    command: command.type ?? null,
    success: true,
    ...fields,
  } satisfies JsonRecord;
}

/** A pi session that resolved the requested model and answers the prompt with `answer` events. */
function runScript(
  answer: (write: (record: JsonRecord) => void) => void,
  prompt: (command: JsonRecord) => JsonRecord = (command) => respond(command),
): RpcScript {
  return (command, write) => {
    if (command.type === "get_state")
      write(
        respond(command, {
          data: {
            model: { provider: "anthropic", id: "claude-sonnet-5" },
            thinkingLevel: "high",
          },
        }),
      );
    if (command.type === "prompt") {
      const response = prompt(command);
      write(response);
      if (response.success === true) answer(write);
    }
  };
}

function assistantAnswer(text: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Reading the patch" },
        { type: "text", text },
      ],
      stopReason: "stop",
    },
  } satisfies JsonRecord;
}

describe("PiRpcClient", () => {
  it("lists only reasoning models the pi login can run, from a child with no tools or extensions", async () => {
    const pi = fakePi({
      rpc: (command, write) => {
        if (command.type !== "get_available_models") return;
        write(
          respond(command, {
            data: {
              models: [
                {
                  provider: "anthropic",
                  id: "claude-sonnet-5",
                  reasoning: true,
                  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
                },
                {
                  provider: "openai-codex",
                  id: "gpt-6-luna",
                  reasoning: true,
                  thinkingLevelMap: { minimal: null, medium: null },
                },
                { provider: "openai", id: "gpt-4o", reasoning: false },
                { provider: "broken" },
              ],
            },
          }),
        );
      },
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.listModels()).resolves.toEqual({
      _tag: "ok",
      value: [
        {
          id: "anthropic/claude-sonnet-5",
          label: "anthropic/claude-sonnet-5",
          reasoning: ["minimal", "low", "medium", "high", "xhigh"],
          defaultReasoning: "medium",
        },
        {
          id: "openai-codex/gpt-6-luna",
          label: "openai-codex/gpt-6-luna",
          reasoning: ["low", "high"],
        },
      ],
    });
    const rpc = pi.spawned.find((spawn) => spawn.args[0] !== "--version");
    expect(rpc?.args).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-approve",
      "--no-tools",
    ]);
    expect(Object.keys(rpc?.options.env ?? {})).not.toContain(
      "ANTHROPIC_API_KEY",
    );
  });

  it("reports an empty model list as a missing login", async () => {
    const pi = fakePi({
      rpc: (command, write) =>
        write(respond(command, { data: { models: [] } })),
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.listModels()).resolves.toEqual({
      _tag: "err",
      error: { reason: "authentication_required", phase: "model_list" },
    });
  });

  it("runs one prompt in the worktree with the read-only tools and parses the final message", async () => {
    const pi = fakePi({
      rpc: runScript((write) => {
        write({ type: "agent_start" });
        write({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "src/a.ts" },
        });
        write(assistantAnswer('```json\n{"title":"Fixture"}\n```'));
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled" });
      }),
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.run(runInput)).resolves.toEqual({
      _tag: "ok",
      value: { title: "Fixture" },
    });
    const rpc = pi.spawned.find((spawn) => spawn.args[0] !== "--version");
    expect(rpc?.args).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-approve",
      "--tools",
      "read,grep,find,ls",
      "--model",
      "anthropic/claude-sonnet-5",
      "--thinking",
      "high",
    ]);
    expect(rpc?.options.cwd).toBe(worktree);
    expect(pi.children[0]?.received).toContainEqual(
      expect.objectContaining({
        type: "prompt",
        message: "Return the Brief as JSON.",
      }),
    );
  });

  it("answers an extension dialog as cancelled at once so the run never waits on a person", async () => {
    const pi = fakePi({
      rpc: (command, write, child) => {
        runScript((emit) => {
          emit({
            type: "extension_ui_request",
            id: "dialog-1",
            method: "confirm",
            title: "Allow?",
          });
          child.stdin.once("data", () => {
            emit(assistantAnswer('{"title":"Fixture"}'));
            emit({ type: "agent_settled" });
          });
        })(command, write, child);
      },
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.run(runInput)).resolves.toMatchObject({ _tag: "ok" });
    expect(pi.children[0]?.received).toContainEqual({
      type: "extension_ui_response",
      id: "dialog-1",
      cancelled: true,
    });
  });

  it("fails a run and aborts pi when a tool outside the read-only allowlist starts", async () => {
    const pi = fakePi({
      rpc: runScript((write) =>
        write({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "rm -rf ." },
        }),
      ),
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.run(runInput)).resolves.toEqual({
      _tag: "err",
      error: { reason: "execution_failed", phase: "tool" },
    });
    expect(pi.children[0]?.received).toContainEqual({ type: "abort" });
  });

  it.each([
    {
      name: "a prompt pi refuses for an expired login",
      prompt: (command: JsonRecord) => ({
        ...respond(command),
        success: false,
        error:
          "Authentication failed for \"anthropic\". Credentials may have expired or network is unavailable. Run '/login anthropic' to re-authenticate.",
      }),
      answer: () => undefined,
      phase: "prompt",
    },
    {
      name: "a provider 401 during the turn",
      prompt: (command: JsonRecord) => respond(command),
      answer: (write: (record: JsonRecord) => void) => {
        write({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "401 Unauthorized: invalid token",
          },
        });
        write({ type: "agent_settled" });
      },
      phase: "turn",
    },
  ])("classifies $name as authentication_required", async (scenario) => {
    const pi = fakePi({ rpc: runScript(scenario.answer, scenario.prompt) });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.run(runInput)).resolves.toEqual({
      _tag: "err",
      error: { reason: "authentication_required", phase: scenario.phase },
    });
  });

  it("refuses a run whose resolved model is not the one requested", async () => {
    const pi = fakePi({
      rpc: (command, write) => {
        if (command.type === "get_state")
          write(
            respond(command, {
              data: {
                model: { provider: "anthropic", id: "claude-haiku-5" },
                thinkingLevel: "high",
              },
            }),
          );
      },
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.run(runInput)).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable", phase: "session_state" },
    });
    expect(pi.children[0]?.received).not.toContainEqual(
      expect.objectContaining({ type: "prompt" }),
    );
  });

  it("reports a pi older than the minimum as runtime_unavailable with the version it needs", async () => {
    const pi = fakePi({ version: "0.79.10", rpc: () => undefined });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.listModels()).resolves.toEqual({
      _tag: "err",
      error: {
        reason: "runtime_unavailable",
        phase: "version",
        requiredVersion: PI_CLI_MINIMUM_VERSION,
      },
    });
    expect(pi.children).toHaveLength(0);
  });

  it("reports a pi binary that cannot start as runtime_unavailable", async () => {
    const client = new PiRpcClient("/nonexistent/patchdesk-test/pi");

    await expect(client.run(runInput)).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable", phase: "version" },
    });
  });
});
