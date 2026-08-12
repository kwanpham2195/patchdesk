import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { buildCodexPrompt, CodexAppServerClient } from "../../src/adapters/codex/codex-app-server-client";
import type { RepresentedReviewWorktree } from "../../src/domain/represented-review-worktree";

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<Record<string, unknown>> = [];
  killed = false;

  constructor(
    private readonly approvalCwd: string,
    private readonly approvalCommand = "cat src/a.ts",
    private readonly completesTurn = true,
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.length === 0) continue;
        const message: unknown = JSON.parse(line);
        if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
        const value = message as Record<string, unknown>;
        this.received.push(value);
        this.respond(value);
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }

  private respond(message: Record<string, unknown>): void {
    if (typeof message.id !== "string" && typeof message.id !== "number") return;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method === "initialize") return this.write({ id: message.id, result: {} });
    if (method === "model/list") return this.write({ id: message.id, result: { data: [{ id: "fixture-codex", displayName: "Fixture Codex", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" }] } });
    if (method === "thread/start") return this.write({ id: message.id, result: { thread: { id: "thread-fixture" } } });
    if (method === "turn/start") {
      this.write({ id: message.id, result: { turn: { id: "turn-fixture" } } });
      this.write({ id: "approval-fixture", method: "item/commandExecution/requestApproval", params: { command: this.approvalCommand, cwd: this.approvalCwd, turnId: "turn-fixture" } });
      this.write({ method: "item/agentMessage/delta", params: { turnId: "turn-fixture", delta: JSON.stringify({ title: "Fixture" }) } });
      if (this.completesTurn) this.write({ method: "turn/completed", params: { turn: { id: "turn-fixture", status: "completed" } } });
      return;
    }
    if (method === "turn/interrupt") return this.write({ id: message.id, result: {} });
    this.write({ id: message.id, result: {} });
  }

  private write(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

const roots: string[] = [];

function representedWorktree(path: string): RepresentedReviewWorktree {
  // SAFETY: every caller creates the fixture root and passes it to the fake Codex process as its app-owned worktree.
  return path as RepresentedReviewWorktree;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
});

describe("CodexAppServerClient", () => {
  it("uses a fresh child, live model list, strict result, and bounded approval policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    const children: FakeCodexProcess[] = [];
    const client = new CodexAppServerClient("codex", {
      processFactory: (file, args, options) => {
        void file;
        void args;
        void options;
        const child = new FakeCodexProcess(root);
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    await expect(client.listModels()).resolves.toMatchObject({ _tag: "ok", value: [{ id: "fixture-codex", reasoning: ["low", "high"] }] });
    const result = await client.run({ worktreePath: representedWorktree(root), expectedHeadSha: "a".repeat(40), model: "fixture-codex", reasoning: "low", prompt: "Return JSON." });
    expect(result).toEqual({ _tag: "ok", value: { title: "Fixture" } });
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.killed)).toBe(true);
    expect(children[1]?.received).toContainEqual({ id: "approval-fixture", result: { decision: "accept" } });
  });

  it("denies an approval whose cwd is outside the represented worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", { processFactory: (file, args, options) => {
      void file;
      void args;
      void options;
      child = new FakeCodexProcess(tmpdir());
      return child as unknown as ChildProcess;
    } });
    await expect(client.run({ worktreePath: representedWorktree(root), expectedHeadSha: "a".repeat(40), model: "fixture-codex", reasoning: "low", prompt: "Return JSON." })).resolves.toMatchObject({ _tag: "ok" });
    expect(child?.received).toContainEqual({ id: "approval-fixture", result: { decision: "decline" } });
  });
  it("denies a repository-controlled executable even when its basename is allowlisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", { processFactory: () => {
      child = new FakeCodexProcess(root, "./cat src/a.ts");
      return child as unknown as ChildProcess;
    } });
    await expect(client.run({ worktreePath: representedWorktree(root), expectedHeadSha: "a".repeat(40), model: "fixture-codex", reasoning: "low", prompt: "Return JSON." })).resolves.toMatchObject({ _tag: "ok" });
    expect(child?.received).toContainEqual({ id: "approval-fixture", result: { decision: "decline" } });
  });

  it("settles a silent turn as timed out and terminates its child", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", { runTimeoutMs: 5, processFactory: () => {
      child = new FakeCodexProcess(root, "cat src/a.ts", false);
      return child as unknown as ChildProcess;
    } });
    await expect(client.run({ worktreePath: representedWorktree(root), expectedHeadSha: "a".repeat(40), model: "fixture-codex", reasoning: "low", prompt: "Return JSON." })).resolves.toEqual({ _tag: "err", error: { reason: "timed_out", phase: "turn" } });
    expect(child?.killed).toBe(true);
  });

  it("rejects prompt paths, credentials, and repository-rule disclosure", () => {
    expect(buildCodexPrompt({ insightType: "analysis", reviewInput: "Read /etc/passwd", policy: "safe" })).toEqual({ _tag: "err", error: "invalid_prompt" });
    expect(buildCodexPrompt({ insightType: "analysis", reviewInput: "token=secret", policy: "safe" })).toEqual({ _tag: "err", error: "invalid_prompt" });
    expect(buildCodexPrompt({ insightType: "analysis", reviewInput: "safe", policy: "repository rules" })).toEqual({ _tag: "err", error: "invalid_prompt" });
  });
});
