import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import type { Result } from "../../src/domain/result";
import type { RepresentedReviewWorktree } from "../../src/domain/represented-review-worktree";

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<CodexRpcMessage> = [];
  killed = false;

  constructor(
    private readonly approvalCwd: string,
    private readonly approvalCommand = "cat src/a.ts",
    private readonly completesTurn = true,
    private readonly deltas: ReadonlyArray<string> = [
      JSON.stringify({ title: "Fixture" }),
    ],
    private readonly finalText?: string,
    private readonly malformedItems = false,
  ) {
    super();
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
        const child = new FakeCodexProcess(root);
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
        child = new FakeCodexProcess(tmpdir());
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
  it("denies a repository-controlled executable even when its basename is allowlisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", {
      processFactory: () => {
        child = new FakeCodexProcess(root, "./cat src/a.ts");
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

  it("settles a silent turn as timed out and terminates its child", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient("codex", {
      runTimeoutMs: 5,
      processFactory: () => {
        child = new FakeCodexProcess(root, "cat src/a.ts", false);
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
    expect(result.value).toContain(
      "The verdict must match the findings: use request_changes when any finding is P0 or P1",
    );
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
  async function runWith(
    deltas: ReadonlyArray<string>,
    finalText?: string,
    malformedItems = false,
  ): Promise<Result<unknown, CodexAppServerFailure>> {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-codex-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;", "utf8");
    const client = new CodexAppServerClient("codex", {
      processFactory: () =>
        asChildProcess(
          new FakeCodexProcess(
            root,
            "cat src/a.ts",
            true,
            deltas,
            finalText,
            malformedItems,
          ),
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
      runWith(['{"citationVersion"'], '{"citationVersion":2,"title":"t"}'),
    ).resolves.toEqual({
      _tag: "ok",
      value: { citationVersion: 2, title: "t" },
    });
  });

  it("falls back to the streamed deltas when the turn carries no message", async () => {
    await expect(runWith(['{"ok"', ":true}"])).resolves.toEqual({
      _tag: "ok",
      value: { ok: true },
    });
  });

  it("falls back to the streamed deltas when the turn's items field is malformed", async () => {
    // A malformed `items` field must not sink an otherwise-completed turn;
    // the delta text is still a valid recovery source.
    await expect(
      runWith(['{"ok"', ":true}"], undefined, true),
    ).resolves.toEqual({
      _tag: "ok",
      value: { ok: true },
    });
  });

  it("reports an invalid result when neither source parses", async () => {
    await expect(runWith(["not json"])).resolves.toEqual({
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
