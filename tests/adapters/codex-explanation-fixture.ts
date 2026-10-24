import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as v from "valibot";
import { CodexAppServerClient } from "#src/adapters/codex/codex-app-server-client";
import {
  codexRpcMessageSchema,
  type CodexRpcMessage,
  type JsonObject,
} from "#src/adapters/codex/codex-app-server-rpc";
import type { CodexExplanationInput } from "#src/adapters/codex/codex-explanation-protocol";
import type { CodexDiagnosticSink } from "#src/adapters/codex/codex-explanation-diagnostics";
import {
  insightArtifactReferenceSchema,
  insightArtifactRunIdSchema,
} from "#src/domain/insight-artifact-scalars";
import type { NativeTurnEvent } from "#src/domain/native-explanation-turn";
import type { RepresentedReviewWorktree } from "#src/domain/represented-review-worktree";
import { ok, type Result } from "#src/domain/result";

export const hostIdentity = {
  runId: v.parse(
    insightArtifactRunIdSchema,
    "insight-guide-1-aaaaaaaaaaaa-fixture",
  ),
  generation: 1,
  cancelEpoch: 0,
  connection: "host_connection",
};
export const reference = v.parse(insightArtifactReferenceSchema, {
  hash: "a".repeat(64),
  bytes: 1,
});
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** No PID is exposed, so production cleanup only calls this inert kill method. */
export class ExplanationProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: CodexRpcMessage[] = [];
  onRequest: ((message: CodexRpcMessage) => boolean) | undefined;
  onStop: (() => void) | undefined;
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = v.parse(codexRpcMessageSchema, JSON.parse(line));
        this.received.push(message);
        if (
          message.method === undefined ||
          message.id === undefined ||
          this.onRequest?.(message)
        )
          continue;
        this.respond(message);
      }
    });
  }
  write(message: CodexRpcMessage): void {
    this.stdout.write(JSON.stringify(message) + "\n");
  }
  kill(): boolean {
    this.onStop?.();
    this.emit("exit", 0, null);
    return true;
  }
  private respond(message: CodexRpcMessage): void {
    if (message.id === undefined) return;
    let result: CodexRpcMessage["result"] = {};
    switch (message.method) {
      case "initialize":
        result = { userAgent: "patchdesk/0.163.0" };
        break;
      case "config/read":
        result = {
          layers: [],
          config: {
            model_provider: "openai",
            mcp_servers: {},
            features: {
              hooks: false,
              plugins: false,
              apps: false,
              enable_mcp_apps: false,
            },
            skills: {
              include_instructions: false,
              bundled: { enabled: false },
            },
            project_doc_max_bytes: 0,
            developer_instructions: "",
          },
        };
        break;
      case "skills/list":
        result = { data: [{ skills: [], errors: [] }] };
        break;
      case "configRequirements/read":
        result = { requirements: null };
        break;
      case "account/read":
        result = {
          account: { type: "chatgpt", email: "email-canary", planType: "plus" },
        };
        break;
      case "model/list":
        result = {
          data: [
            {
              id: "model-canary",
              displayName: "Fixture",
              supportedReasoningEfforts: [{ reasoningEffort: "low" }],
              defaultReasoningEffort: "low",
            },
          ],
          nextCursor: null,
        };
        break;
      case "thread/start":
        result = {
          thread: { id: "thread-canary" },
          model: "model-canary",
          reasoningEffort: "low",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: { type: "workspaceWrite" },
          instructionSources: [],
        };
        break;
      case "turn/start":
        result = { turn: { id: "turn-canary" } };
        break;
    }
    this.write({ id: message.id, result });
  }
}

export const completion: CodexRpcMessage = {
  method: "turn/completed",
  params: { threadId: "thread-canary", turn: { id: "turn-canary" } },
};
export function asExplanationChild(fake: ExplanationProcess): ChildProcess {
  const surface: Pick<ChildProcess, "stdin" | "stdout" | "stderr" | "kill"> =
    fake;
  // SAFETY: ExplanationProcess implements the pipes, EventEmitter and kill used by RpcChild without a real PID.
  return surface as ChildProcess;
}
export function toolMessage(
  id = 0,
  params: {
    readonly namespace?: string | null | undefined;
    readonly callId?: string;
    readonly threadId?: string;
    readonly turnId?: string;
    readonly tool?: string;
    readonly arguments?: JsonObject;
  } = {},
): CodexRpcMessage {
  return {
    id,
    method: "item/tool/call",
    params: {
      threadId: "thread-canary",
      turnId: "turn-canary",
      callId: "call-canary",
      namespace: null,
      tool: "lookup_receipt",
      arguments: { opId: "operation-canary" },
      ...params,
    },
  };
}

export function explanationFixture(sink?: CodexDiagnosticSink) {
  const abort = new AbortController(),
    finish = new AbortController();
  const children: ExplanationProcess[] = [],
    observations: NativeTurnEvent[] = [];
  const bound = deferred<void>();
  const controls = {
    onTurn: (_child: ExplanationProcess, _message: CodexRpcMessage): boolean =>
      false,
    observe: async (
      _event: NativeTurnEvent,
    ): Promise<Result<void, "unknown">> => ok(undefined),
    cleanup: async (): Promise<void> => undefined,
  };
  const client = new CodexAppServerClient("fixture-executable", {
    processFactory: () => {
      const child = new ExplanationProcess();
      children.push(child);
      child.onRequest = (message) =>
        message.method === "turn/start" && controls.onTurn(child, message);
      return asExplanationChild(child);
    },
    homeFactory: async () =>
      ok({
        original: "/source-canary",
        directory: "/home-canary",
        login: {},
        unchanged: async () => true,
        cleanup: () => controls.cleanup(),
      }),
  });
  const receipts: string[] = [];
  const input: CodexExplanationInput = {
    // SAFETY: the inert process never reads the fixture worktree.
    run: {
      worktreePath: "/worktree-canary" as RepresentedReviewWorktree,
      expectedHeadSha: "a".repeat(40),
      model: "model-canary",
      reasoning: "low",
      prompt: "prompt-source-canary",
    },
    identity: hostIdentity,
    signal: abort.signal,
    deadline: { kind: "no-total-deadline/1" },
    diagnostic: sink,
    binding: {
      kind: "guide",
      tool: async (call) => {
        if (call.tool !== "finish") return { status: "not_found" };
        receipts.push(call.input.opId);
        finish.abort();
        return {
          status: "receipt",
          sequence: 1,
          result: { sequence: 1, receipts: { root: reference, count: 0 } },
        };
      },
    },
    lifecycle: {
      finishSignal: finish.signal,
      start: async () => ok(reference),
      observe: async (event) => {
        observations.push(event);
        const result = await controls.observe(event);
        if (event.kind === "provider_turn") bound.resolve();
        return result;
      },
    },
  };
  return {
    client,
    input,
    abort,
    finish,
    children,
    bound,
    controls,
    observations,
    receipts,
  };
}
