import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSessionAttemptStore } from "#src/adapters/storage/native-session-attempt-store";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";

import { PiRpcClient } from "#src/adapters/pi-cli/pi-rpc-client";
import type { RepresentedReviewWorktree } from "#src/domain/represented-review-worktree";
import {
  assistantAnswer,
  fakePi,
  respond,
  runScript,
  type JsonRecord,
} from "./pi-rpc-test-support";

const worktree = "/tmp/patchdesk-worktree" as RepresentedReviewWorktree;
let attempt: NativeSessionAttemptStore;
let attemptRoot: string;
beforeEach(async () => {
  attemptRoot = await realpath(
    await mkdtemp(join(tmpdir(), "patchdesk-pi-attempt-")),
  );
  const created = await NativeSessionAttemptStore.create(
    PatchdeskPaths.fromEnvironment({
      PATCHDESK_CONFIG_DIRECTORY: join(attemptRoot, "config"),
      PATCHDESK_DATA_DIRECTORY: join(attemptRoot, "data"),
      PATCHDESK_CACHE_DIRECTORY: join(attemptRoot, "cache"),
    }),
    {
      identity: {
        profileId: "profile",
        reviewId: "review-fixture",
        sessionId:
          "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__abcdef123456",
        runId: "insight-brief-1-aaaaaaaaaaaa-fixture",
        type: "brief",
      },
      bundleId: "a".repeat(64),
    } as never,
    undefined,
    "anthropic/claude-sonnet-5",
    "high",
    "pi-cli-account",
  );
  if (created._tag === "err")
    throw new Error("Could not create native attempt fixture");
  attempt = created.value;
});
afterEach(async () => {
  await rm(attemptRoot, { recursive: true, force: true });
});
const runInput = {
  get attempt() {
    return attempt;
  },
  worktreePath: worktree,
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
  prompt: "Return the Brief as JSON.",
} as const;

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
    const rpc = pi.spawned.find((spawn) => spawn.args[0] === "--mode");
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

  it("runs one prompt in the worktree with the selected inspection tools and parses the final message", async () => {
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
    const rpc = pi.spawned.find((spawn) => spawn.args[0] === "--mode");
    expect(rpc?.args).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      attempt.sessionDirectory,
      "--no-extensions",
      "--no-approve",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--offline",
      "--tools",
      "read,grep,find,ls,bash",
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

  it("fails a run and aborts pi when a tool outside the inspection allowlist starts", async () => {
    const pi = fakePi({
      rpc: runScript((write) =>
        write({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "edit",
          args: { path: "src/a.ts", oldText: "old", newText: "new" },
        }),
      ),
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.run(runInput)).resolves.toEqual({
      _tag: "err",
      error: {
        reason: "execution_failed",
        phase: "tool",
        code: "tool_execution_failed",
        detail: "The provider refused or failed the run.",
      },
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
      error: {
        reason: "authentication_required",
        phase: scenario.phase,
        code: `${scenario.phase}_authentication_required`,
        detail: "The provider requires authentication.",
      },
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
      error: {
        reason: "runtime_unavailable",
        phase: "session_state",
        code: "session_state_runtime_unavailable",
        detail: "The selected runtime or required capability is unavailable.",
      },
    });
    expect(pi.children[0]?.received).not.toContainEqual(
      expect.objectContaining({ type: "prompt" }),
    );
  });

  it("reports a pi missing required isolation flags as runtime_unavailable", async () => {
    const pi = fakePi({
      version: "0.79.10",
      help: "--mode rpc",
      rpc: () => undefined,
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(client.listModels()).resolves.toEqual({
      _tag: "err",
      error: {
        reason: "runtime_unavailable",
        phase: "native_isolation_unsupported",
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

  it("cancels a run whose cancel arrives while pi --version is still running", async () => {
    let releaseVersion: () => void = () => undefined;
    const pi = fakePi({
      versionReleased: new Promise((resolve) => {
        releaseVersion = resolve;
      }),
      rpc: runScript((write) => {
        write(assistantAnswer('{"title":"Fixture"}'));
        write({ type: "agent_settled" });
      }),
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });
    const controller = new AbortController();

    const running = client.run(runInput, { signal: controller.signal });
    controller.abort();
    releaseVersion();

    await expect(running).resolves.toMatchObject({
      _tag: "err",
      error: { reason: "cancelled" },
    });
    expect(pi.children[0]?.received ?? []).not.toContainEqual(
      expect.objectContaining({ type: "prompt" }),
    );
  });

  it("refuses a run whose resolved thinking level is not the one requested", async () => {
    const pi = fakePi({
      rpc: (command, write) => {
        if (command.type === "get_state")
          write(
            respond(command, {
              data: {
                model: { provider: "anthropic", id: "claude-sonnet-5" },
                thinkingLevel: "medium",
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
      error: {
        reason: "runtime_unavailable",
        phase: "session_state",
        code: "session_state_runtime_unavailable",
        detail: "The selected runtime or required capability is unavailable.",
      },
    });
    expect(pi.children[0]?.received).not.toContainEqual(
      expect.objectContaining({ type: "prompt" }),
    );
  });

  it("aborts pi and reports cancelled when a running turn is cancelled", async () => {
    let prompted: () => void = () => undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      prompted = resolve;
    });
    const pi = fakePi({ rpc: runScript(() => prompted()) });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });
    const controller = new AbortController();

    const running = client.run(runInput, { signal: controller.signal });
    await promptAccepted;
    controller.abort();

    await expect(running).resolves.toEqual({
      _tag: "err",
      error: {
        reason: "cancelled",
        phase: "turn",
        code: "turn_cancelled",
        detail: "The run was cancelled.",
      },
    });
    expect(pi.children[0]?.received).toContainEqual({ type: "abort" });
  });

  it("aborts pi and reports timed_out when a turn outlives its run bound", async () => {
    const pi = fakePi({ rpc: runScript(() => undefined) });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(
      client.run({ ...runInput, runTimeoutMs: 50 }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        reason: "timed_out",
        phase: "turn",
        code: "turn_timed_out",
        detail: "The provider run timed out.",
      },
    });
    expect(pi.children[0]?.received).toContainEqual({ type: "abort" });
  });

  it("refuses a prompt over its byte bound without starting pi", async () => {
    const pi = fakePi({ rpc: () => undefined });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(
      client.run({ ...runInput, maxPromptBytes: 8 }),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_result", phase: "prompt" },
    });
    expect(pi.spawned).toHaveLength(0);
  });

  it("stops pi and fails the run when one RPC record passes 32 MiB", async () => {
    const pi = fakePi({
      rpc: runScript((write) => {
        write(assistantAnswer("x".repeat(33 * 1024 * 1024)));
        write({ type: "agent_settled" });
      }),
    });
    const client = new PiRpcClient("/usr/local/bin/pi", {
      processFactory: pi.processFactory,
    });

    await expect(
      client.run({ ...runInput, runTimeoutMs: 2_000 }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        reason: "execution_failed",
        phase: "turn",
        code: "turn_execution_failed",
        detail: "The provider refused or failed the run.",
      },
    });
  });
});
