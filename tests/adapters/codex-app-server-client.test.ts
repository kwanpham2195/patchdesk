import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";

import {
  buildCodexAnalysisPrompt,
  buildCodexWalkthroughPrompt,
  codexRpcMessageSchema,
  CodexAppServerClient,
  MAX_ANALYSIS_CODEX_PROMPT_BYTES,
  MAX_WALKTHROUGH_PROMPT_BYTES,
  parseTurnJson,
  type CodexAppServerFailure,
  type CodexRpcMessage,
} from "../../src/adapters/codex/codex-app-server-client";
import type {
  InsightActivityEvent,
  InsightActivitySink,
} from "../../src/adapters/codex/codex-activity";
import type { Result } from "../../src/domain/result";
import type { RepresentedReviewWorktree } from "../../src/domain/represented-review-worktree";
import { InsightActivityBuffer } from "../../src/services/insight-activity-buffer";
import { composeReviewPrompt } from "../../src/services/review-rubric";

type FakeCodexProcessOptions = {
  readonly approvalCwd: string;
  readonly approvalCommand?: string;
  readonly completesTurn?: boolean;
  readonly deltas?: ReadonlyArray<string>;
  readonly finalText?: string | undefined;
  readonly malformedItems?: boolean | undefined;
  readonly notifications?: ReadonlyArray<CodexRpcMessage>;
};

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<CodexRpcMessage> = [];
  killed = false;
  private readonly approvalCwd: string;
  private readonly approvalCommand: string;
  private readonly completesTurn: boolean;
  private readonly deltas: ReadonlyArray<string>;
  private readonly finalText: string | undefined;
  private readonly malformedItems: boolean;
  private readonly notifications: ReadonlyArray<CodexRpcMessage>;

  constructor(options: FakeCodexProcessOptions) {
    super();
    this.approvalCwd = options.approvalCwd;
    this.approvalCommand = options.approvalCommand ?? "cat src/a.ts";
    this.completesTurn = options.completesTurn ?? true;
    this.deltas = options.deltas ?? [JSON.stringify({ title: "Fixture" })];
    this.finalText = options.finalText;
    this.malformedItems = options.malformedItems ?? false;
    this.notifications = options.notifications ?? [];
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.length === 0) continue;
        const parsed = v.safeParse(codexRpcMessageSchema, JSON.parse(line));
        if (!parsed.success) continue;
        this.received.push(parsed.output);
        this.respond(parsed.output);
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }

  private respond(message: CodexRpcMessage): void {
    if (message.id === undefined) return;
    const method = message.method;
    if (method === "initialize")
      return this.write({ id: message.id, result: {} });
    if (method === "model/list")
      return this.write({
        id: message.id,
        result: {
          data: [
            {
              id: "fixture-codex",
              displayName: "Fixture Codex",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "low",
            },
          ],
          nextCursor: null,
        },
      });
    if (method === "thread/start")
      return this.write({
        id: message.id,
        result: { thread: { id: "thread-fixture" } },
      });
    if (method === "turn/start") {
      this.write({ id: message.id, result: { turn: { id: "turn-fixture" } } });
      this.write({
        id: "approval-fixture",
        method: "item/commandExecution/requestApproval",
        params: {
          command: this.approvalCommand,
          cwd: this.approvalCwd,
          turnId: "turn-fixture",
        },
      });
      for (const notification of this.notifications) this.write(notification);
      for (const delta of this.deltas)
        this.write({
          method: "item/agentMessage/delta",
          params: { turnId: "turn-fixture", delta },
        });
      if (this.completesTurn) {
        const turn = this.malformedItems
          ? { id: "turn-fixture", status: "completed", items: "not-an-array" }
          : this.finalText === undefined
            ? { id: "turn-fixture", status: "completed" }
            : {
                id: "turn-fixture",
                status: "completed",
                items: [{ type: "agentMessage", text: this.finalText }],
              };
        this.write({
          method: "turn/completed",
          params: { turn },
        });
      }
      return;
    }
    if (method === "turn/interrupt")
      return this.write({ id: message.id, result: {} });
    this.write({ id: message.id, result: {} });
  }

  private write(message: CodexRpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * The exact ChildProcess surface RpcChild reads: stdin/stdout/stderr, kill(), and once(). `once`
 * is declared to return `void` rather than `this` so this type stays satisfiable by any
 * EventEmitter, since RpcChild never chains off its result.
 */
type ChildProcessSurface = {
  readonly stdin: ChildProcess["stdin"];
  readonly stdout: ChildProcess["stdout"];
  readonly stderr: ChildProcess["stderr"];
  kill(): boolean;
  once(event: string, listener: (...args: unknown[]) => void): void;
};

/** Adapts a fake Codex process for injection through the child-process factory hook. */
function asChildProcess(fake: FakeCodexProcess): ChildProcess {
  const surface: ChildProcessSurface = fake;
  // SAFETY: RpcChild only reads a ChildProcess's stdin/stdout/stderr streams, calls kill(), and
  // listens for its "error"/"exit" events; `surface` (typed as exactly that member set) is
  // structurally satisfied by FakeCodexProcess above, so widening it back to the full
  // ChildProcess interface never crosses a member the adapter actually touches.
  return surface as ChildProcess;
}

const roots: string[] = [];

function representedWorktree(path: string): RepresentedReviewWorktree {
  // SAFETY: every caller creates the fixture root and passes it to the fake Codex process as its app-owned worktree.
  return path as RepresentedReviewWorktree;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await import("node:fs/promises").then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    );
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
        const child = new FakeCodexProcess({ approvalCwd: root });
        children.push(child);
        return asChildProcess(child);
      },
    });

    await expect(client.listModels()).resolves.toMatchObject({
      _tag: "ok",
      value: [{ id: "fixture-codex", reasoning: ["low", "high"] }],
    });
    const result = await client.run({
      worktreePath: representedWorktree(root),
      expectedHeadSha: "a".repeat(40),
      model: "fixture-codex",
      reasoning: "low",
      prompt: "Return JSON.",
    });
    expect(result).toEqual({ _tag: "ok", value: { title: "Fixture" } });
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.killed)).toBe(true);
    expect(children[1]?.received).toContainEqual({
      id: "approval-fixture",
      result: { decision: "accept" },
    });
  });

  it("denies an approval whose cwd is outside the represented worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", {
      processFactory: (file, args, options) => {
        void file;
        void args;
        void options;
        child = new FakeCodexProcess({ approvalCwd: tmpdir() });
        return asChildProcess(child);
      },
    });
    await expect(
      client.run({
        worktreePath: representedWorktree(root),
        expectedHeadSha: "a".repeat(40),
        model: "fixture-codex",
        reasoning: "low",
        prompt: "Return JSON.",
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(child?.received).toContainEqual({
      id: "approval-fixture",
      result: { decision: "decline" },
    });
  });
  it("denies an approval whose cwd is a symlink outside the represented worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    const outside = await mkdtemp(join(tmpdir(), "patchdesk-codex-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    await symlink(outside, join(root, "escape"));
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", {
      processFactory: () => {
        child = new FakeCodexProcess({ approvalCwd: join(root, "escape") });
        return asChildProcess(child);
      },
    });
    await expect(
      client.run({
        worktreePath: representedWorktree(root),
        expectedHeadSha: "a".repeat(40),
        model: "fixture-codex",
        reasoning: "low",
        prompt: "Return JSON.",
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(child?.received).toContainEqual({
      id: "approval-fixture",
      result: { decision: "decline" },
    });
  });

  it("accepts a repository-controlled executable requested inside the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", {
      processFactory: () => {
        child = new FakeCodexProcess({
          approvalCwd: root,
          approvalCommand: "./cat src/a.ts",
        });
        return asChildProcess(child);
      },
    });
    await expect(
      client.run({
        worktreePath: representedWorktree(root),
        expectedHeadSha: "a".repeat(40),
        model: "fixture-codex",
        reasoning: "low",
        prompt: "Return JSON.",
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(child?.received).toContainEqual({
      id: "approval-fixture",
      result: { decision: "accept" },
    });
  });

  it("settles a silent turn as timed out and terminates its child", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", {
      runTimeoutMs: 5,
      processFactory: () => {
        child = new FakeCodexProcess({
          approvalCwd: root,
          completesTurn: false,
        });
        return asChildProcess(child);
      },
    });
    await expect(
      client.run({
        worktreePath: representedWorktree(root),
        expectedHeadSha: "a".repeat(40),
        model: "fixture-codex",
        reasoning: "low",
        prompt: "Return JSON.",
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "timed_out", phase: "turn" },
    });
    expect(child?.killed).toBe(true);
  });

  it("emits command and reasoning activity without command output", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    const longCommand = `rg ${"x".repeat(400)}`;
    const commandItem = (fields: {
      readonly id: string;
      readonly command: string;
      readonly status: string;
      readonly aggregatedOutput: string | null;
      readonly exitCode: number | null;
      readonly durationMs: number | null;
    }) => ({
      type: "commandExecution",
      cwd: root,
      processId: null,
      commandActions: [],
      ...fields,
    });
    const notifications: ReadonlyArray<CodexRpcMessage> = [
      {
        method: "item/started",
        params: {
          item: { type: "reasoning", id: "rs-1", summary: [], content: [] },
        },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: {
          itemId: "rs-1",
          delta: "**Reading the diff**",
          summaryIndex: 0,
        },
      },
      {
        method: "item/started",
        params: {
          item: commandItem({
            id: "cmd-1",
            command: `cat ${root}/src/a.ts`,
            status: "inProgress",
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          }),
        },
      },
      {
        method: "item/completed",
        params: {
          item: commandItem({
            id: "cmd-1",
            command: `cat ${root}/src/a.ts`,
            status: "completed",
            aggregatedOutput: "export const a = 1;",
            exitCode: 0,
            durationMs: 12,
          }),
        },
      },
      {
        method: "item/completed",
        params: {
          item: commandItem({
            id: "cmd-2",
            command: longCommand,
            status: "declined",
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          }),
        },
      },
      {
        method: "item/started",
        params: { item: { type: "fileChange", id: "fc-1", changes: [] } },
      },
    ];
    const events: InsightActivityEvent[] = [];
    const client = new CodexAppServerClient("codex", {
      processFactory: () =>
        asChildProcess(
          new FakeCodexProcess({
            approvalCwd: tmpdir(),
            approvalCommand: "pwd",
            notifications,
          }),
        ),
    });

    const result = await client.run(
      {
        worktreePath: representedWorktree(root),
        expectedHeadSha: "a".repeat(40),
        model: "fixture-codex",
        reasoning: "low",
        prompt: "Return JSON.",
      },
      { onActivity: (event) => events.push(event) },
    );

    expect(result).toEqual({ _tag: "ok", value: { title: "Fixture" } });
    // The approval answer waits on `realpath`, so its position among the notifications is not fixed.
    expect(
      events.filter((event) => event._tag !== "approval_answered"),
    ).toEqual([
      { _tag: "turn_started" },
      {
        _tag: "reasoning_delta",
        itemId: "rs-1",
        delta: "**Reading the diff**",
      },
      { _tag: "command_started", id: "cmd-1", command: "cat src/a.ts" },
      {
        _tag: "command_completed",
        id: "cmd-1",
        command: "cat src/a.ts",
        status: "completed",
        exitCode: 0,
        durationMs: 12,
      },
      {
        _tag: "command_completed",
        id: "cmd-2",
        command: longCommand.slice(0, 200),
        status: "declined",
      },
    ]);
  });

  it("completes the turn when the activity callback throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    const client = new CodexAppServerClient("codex", {
      processFactory: () =>
        asChildProcess(
          new FakeCodexProcess({
            approvalCwd: tmpdir(),
            approvalCommand: "pwd",
          }),
        ),
    });

    await expect(
      client.run(
        {
          worktreePath: representedWorktree(root),
          expectedHeadSha: "a".repeat(40),
          model: "fixture-codex",
          reasoning: "low",
          prompt: "Return JSON.",
        },
        {
          onActivity: () => {
            throw new Error("sink failed");
          },
        },
      ),
    ).resolves.toEqual({ _tag: "ok", value: { title: "Fixture" } });
  });

  // `classifyThrownFailure` reads ENOENT with the shared `isNotFound`, which
  // takes `code` off any object rather than requiring `instanceof Error`. A
  // spawn failure that crossed a realm boundary — an Electron utility process,
  // a worker thread, a `vm` context — arrives ENOENT-shaped but not an `Error`
  // of this realm, and still means "the Codex binary is not there".
  it("reports a non-Error ENOENT from the spawn as runtime_unavailable", async () => {
    const client = new CodexAppServerClient("codex", {
      processFactory: () => {
        throw { code: "ENOENT" };
      },
    });

    await expect(client.listModels()).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable", phase: "initialize" },
    });
  });

  it("reports a non-Error spawn failure under another code as execution_failed", async () => {
    const client = new CodexAppServerClient("codex", {
      processFactory: () => {
        throw { code: "EACCES" };
      },
    });

    await expect(client.listModels()).resolves.toEqual({
      _tag: "err",
      error: { reason: "execution_failed", phase: "initialize" },
    });
  });
});

describe("CodexAppServerClient approval requests", () => {
  async function runWithRequests(
    requests: ReadonlyArray<{
      readonly id: string;
      readonly method: string;
      readonly params: {
        readonly cwd?: string | undefined;
        readonly command?: string | undefined;
        readonly kind?: string;
        readonly networkApprovalContext?: {
          readonly host: string;
          readonly protocol: string;
        };
        readonly proposedExecpolicyAmendment?: ReadonlyArray<string>;
      };
    }>,
    onActivity?: InsightActivitySink,
  ): Promise<FakeCodexProcess> {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    const child = new FakeCodexProcess({
      approvalCwd: root,
      notifications: requests.map((request) => ({
        ...request,
        params: { cwd: root, command: "cat src/a.ts", ...request.params },
      })),
    });
    const client = new CodexAppServerClient("codex", {
      processFactory: () => asChildProcess(child),
    });
    await expect(
      client.run(
        {
          worktreePath: representedWorktree(root),
          expectedHeadSha: "a".repeat(40),
          model: "fixture-codex",
          reasoning: "low",
          prompt: "Return JSON.",
        },
        { onActivity },
      ),
    ).resolves.toMatchObject({ _tag: "ok" });
    return child;
  }

  it("starts the thread with the untrusted approval policy", async () => {
    const child = await runWithRequests([]);
    expect(
      child.received.find((message) => message.method === "thread/start")
        ?.params,
    ).toMatchObject({ sandbox: "read-only", approvalPolicy: "untrusted" });
  });

  it("declines stdin writes, file changes, and network approvals", async () => {
    const child = await runWithRequests([
      {
        id: "stdin",
        method: "item/commandExecution/requestApproval",
        params: { kind: "writeStdin" },
      },
      {
        id: "file-change",
        method: "item/fileChange/requestApproval",
        params: {},
      },
      {
        id: "network",
        method: "item/commandExecution/requestApproval",
        params: {
          networkApprovalContext: { host: "example.com", protocol: "https" },
        },
      },
    ]);
    expect(child.received).toContainEqual({
      id: "stdin",
      result: { decision: "decline" },
    });
    expect(child.received).toContainEqual({
      id: "file-change",
      result: { decision: "decline" },
    });
    expect(child.received).toContainEqual({
      id: "network",
      result: { decision: "decline" },
    });
  });

  it("declines malformed command approval requests", async () => {
    const child = await runWithRequests([
      {
        id: "missing-command",
        method: "item/commandExecution/requestApproval",
        params: { command: undefined },
      },
      {
        id: "missing-cwd",
        method: "item/commandExecution/requestApproval",
        params: { cwd: undefined },
      },
    ]);
    expect(child.received).toContainEqual({
      id: "missing-command",
      result: { decision: "decline" },
    });
    expect(child.received).toContainEqual({
      id: "missing-cwd",
      result: { decision: "decline" },
    });
  });

  // A plain `accept` never applies a proposed amendment upstream.
  it("accepts any command requested from inside the represented worktree", async () => {
    const child = await runWithRequests([
      {
        id: "arbitrary-command",
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          command: "pnpm exec tsc --noEmit && printf done",
        },
      },
    ]);
    expect(child.received).toContainEqual({
      id: "arbitrary-command",
      result: { decision: "accept" },
    });
  });

  it("counts the accepted and declined command approvals in the activity snapshot", async () => {
    const buffer = new InsightActivityBuffer();
    await runWithRequests(
      [
        {
          id: "outside",
          method: "item/commandExecution/requestApproval",
          params: { cwd: "/", command: "cat /etc/passwd" },
        },
      ],
      (event) => buffer.append(event),
    );
    expect(buffer.snapshot().approvals).toEqual({ accepted: 1, declined: 1 });
  });

  it("answers a permissions request with an empty profile, which grants nothing", async () => {
    const child = await runWithRequests([
      {
        id: "permissions",
        method: "item/permissions/requestApproval",
        params: {},
      },
    ]);
    expect(child.received).toContainEqual({
      id: "permissions",
      result: { permissions: {}, scope: "turn" },
    });
  });
});

describe("buildCodexAnalysisPrompt", () => {
  const analysisPrompt = [
    "Review the complete represented pull request.",
    "PR: patchdesk#754",
    '{"changedFiles":["src/a.ts"]}',
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,4 +1,5 @@",
      " /**",
      " * Reads /etc/passwd for demonstration only, never executed.",
      " */",
      "+export const a = 1;",
    ].join("\n"),
  ].join("\n\n");

  it("does not apply the unsafe-content guard to the patch, includes the shape block and the verdict rule", () => {
    const result = buildCodexAnalysisPrompt({
      analysisPrompt,
      policy: "Read only the represented review revision.",
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value).toContain(analysisPrompt);
    expect(result.value).toContain(" /**");
    expect(result.value).toContain('"changeSummary":string');
    expect(result.value).toContain(
      '"verdict":"approve"|"comment"|"request_changes"',
    );
    expect(result.value).toContain('"findings":[{"id":string');
  });

  it("carries the shared Analysis prompt and adds no second severity or verdict rule", () => {
    const shared = composeReviewPrompt({
      reviewInput: "# PR review input",
      context: '{"projectReviewCriteria":[]}',
      fullPatch: "diff --git a/src/a.ts b/src/a.ts",
    });
    const result = buildCodexAnalysisPrompt({
      analysisPrompt: shared,
      policy: "Read only the represented review revision.",
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value).toContain(shared);
    expect(result.value).toContain("ASD-STE100 / Simplified Technical English");
    expect(result.value).toContain("Never invent the why.");
    expect(result.value).toContain(
      "P0 is a defect that loses data, breaks security, or blocks the release.",
    );
    expect(result.value).toContain(
      "P1 is a correctness defect a user will hit.",
    );
    expect(result.value).toContain(
      "P2 is a defect with a workaround, or a real maintainability risk.",
    );
    expect(result.value).toContain("P3 is a nit.");
    expect(result.value).toContain("REVIEW INPUT:");
    expect(result.value).toContain("REVIEW CONTEXT DOCUMENT:");
    expect(result.value).toContain("PATCH ARTIFACT:");
    expect(
      result.value.split("The verdict must match the findings").length - 1,
    ).toBe(1);
  });

  it("still rejects an unsafe policy", () => {
    expect(
      buildCodexAnalysisPrompt({
        analysisPrompt,
        policy: "Read /etc/passwd",
      }),
    ).toEqual({ _tag: "err", error: "invalid_prompt" });
  });

  it("rejects an over-size composed prompt", () => {
    const oversized = "x".repeat(MAX_ANALYSIS_CODEX_PROMPT_BYTES);
    expect(
      buildCodexAnalysisPrompt({
        analysisPrompt: oversized,
        policy: "Read only.",
      }),
    ).toEqual({ _tag: "err", error: "invalid_prompt" });
  });
});

describe("buildCodexWalkthroughPrompt", () => {
  const walkthroughPrompt = [
    "HUNK ALIAS MANIFEST:",
    "h1 | src/adapters/codex/codex-app-server-client.ts | @@ -1,3 +1,4 @@",
    "PATCH ARTIFACT:",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    "+/**",
    "+ * Reads /etc/passwd for demonstration only, never executed.",
    "+ */",
  ].join("\n");

  it("does not apply the unsafe-content guard to the walkthrough prompt, and includes the shape block and manifest", () => {
    const result = buildCodexWalkthroughPrompt({
      walkthroughPrompt,
      policy: "Read only the represented review revision.",
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value).toContain(walkthroughPrompt);
    expect(result.value).toContain("HUNK ALIAS MANIFEST");
    expect(result.value).toContain(
      '{"citationVersion":2,"title":string,"focus":string,"chapters":[{"title":string,"sections":[{"title":string,"prose":string,"hunkIds":[string]}]}]}',
    );
  });

  it("leaves the chapter, section, and character limits to the shared walkthrough prompt", () => {
    const result = buildCodexWalkthroughPrompt({
      walkthroughPrompt,
      policy: "Read only the represented review revision.",
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value).toContain("Use no other keys.");
    expect(result.value).not.toContain("320");
    expect(result.value).not.toContain("at most 12 chapters");
  });

  it("still rejects an unsafe policy", () => {
    expect(
      buildCodexWalkthroughPrompt({
        walkthroughPrompt,
        policy: "Read /etc/passwd",
      }),
    ).toEqual({ _tag: "err", error: "invalid_prompt" });
  });

  it("rejects an over-size composed prompt", () => {
    const oversized = "x".repeat(MAX_WALKTHROUGH_PROMPT_BYTES);
    expect(
      buildCodexWalkthroughPrompt({
        walkthroughPrompt: oversized,
        policy: "Read only.",
      }),
    ).toEqual({ _tag: "err", error: "invalid_prompt" });
  });
});

describe("turn/completed answer selection", () => {
  async function runWith(input: {
    readonly deltas: ReadonlyArray<string>;
    readonly finalText?: string | undefined;
    readonly malformedItems?: boolean | undefined;
  }): Promise<Result<unknown, CodexAppServerFailure>> {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    const client = new CodexAppServerClient("codex", {
      processFactory: () =>
        asChildProcess(
          new FakeCodexProcess({
            approvalCwd: root,
            deltas: input.deltas,
            finalText: input.finalText,
            malformedItems: input.malformedItems,
          }),
        ),
    });
    return client.run({
      worktreePath: representedWorktree(root),
      expectedHeadSha: "a".repeat(40),
      model: "fixture-codex",
      reasoning: "low",
      prompt: "Return JSON.",
    });
  }

  it("prefers the completed turn's message over incomplete deltas", async () => {
    // The protocol does not guarantee deltas; a turn that completed with a
    // final message must not fail because the stream was partial.
    await expect(
      runWith({
        deltas: ['{"citationVersion"'],
        finalText: '{"citationVersion":2,"title":"t"}',
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { citationVersion: 2, title: "t" },
    });
  });

  it("falls back to the streamed deltas when the turn carries no message", async () => {
    await expect(runWith({ deltas: ['{"ok"', ":true}"] })).resolves.toEqual({
      _tag: "ok",
      value: { ok: true },
    });
  });

  it("falls back to the streamed deltas when the turn's items field is malformed", async () => {
    // A malformed `items` field must not sink an otherwise-completed turn;
    // the delta text is still a valid recovery source.
    await expect(
      runWith({ deltas: ['{"ok"', ":true}"], malformedItems: true }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { ok: true },
    });
  });

  it("reports an invalid result when neither source parses", async () => {
    await expect(runWith({ deltas: ["not json"] })).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_result", phase: "turn" },
    });
  });
});

describe("parseTurnJson", () => {
  it("parses bare JSON", () => {
    expect(parseTurnJson('{"a":1}')).toEqual({ _tag: "ok", value: { a: 1 } });
  });

  it("parses a fenced ```json reply", () => {
    expect(parseTurnJson('```json\n{"a":1}\n```')).toEqual({
      _tag: "ok",
      value: { a: 1 },
    });
  });

  it("parses a fenced ``` reply with no language tag", () => {
    expect(parseTurnJson('```\n{"a":1}\n```')).toEqual({
      _tag: "ok",
      value: { a: 1 },
    });
  });

  it("rejects invalid text", () => {
    expect(parseTurnJson("not json")).toEqual({
      _tag: "err",
      error: "invalid_json",
    });
  });
});
