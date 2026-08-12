import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { err, ok, type Result } from "../../domain/result";
import type { InsightReasoning } from "../../domain/insight-provider";
import type { RepresentedReviewWorktree } from "../../domain/represented-review-worktree";
import { insightOutputGuidance } from "../../domain/insight-output-guidance";
import type { InsightFailureCategory } from "../../domain/insight-record";

const CLIENT_NAME = "patchdesk";
const CLIENT_VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_DISCOVERY_DEADLINE_MS = 30_000;
const MAX_MODEL_PAGES = 50;
const MAX_MODELS = 512;
const MAX_MODEL_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const RUN_TIMEOUT_MS = 5 * 60_000;

const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval";
const PERMISSIONS_APPROVAL_METHOD = "item/permissions/requestApproval";

/** A renderer-safe model entry returned by Codex's live model/list method. */
export type CodexModel = {
  readonly id: string;
  readonly label: string;
  readonly reasoning: ReadonlyArray<InsightReasoning>;
  readonly defaultReasoning?: InsightReasoning;
};

/** Typed failures returned by the Codex process adapter. */
export type CodexAppServerFailure = {
  readonly reason: InsightFailureCategory | "cancelled";
  readonly phase:
    | "resolve"
    | "initialize"
    | "model_list"
    | "thread_start"
    | "turn_start"
    | "turn"
    | "approval"
    | "cleanup";
};

/** An app-owned immutable worktree and sanitized prompt bound to one run. */
export type CodexRunInput = {
  readonly worktreePath: RepresentedReviewWorktree;
  readonly expectedHeadSha: string;
  readonly model: string;
  readonly reasoning: InsightReasoning;
  readonly prompt: string;
};

type RpcMessage = Readonly<Record<string, unknown>>;
type PendingRequest = {
  readonly resolve: (value: RpcMessage) => void;
  readonly reject: (cause: RpcFailure) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type RpcFailure =
  | "cancelled"
  | "timeout"
  | "process_unavailable"
  | "process_failed"
  | "stopped"
  | "invalid_rpc_result"
  | {
      readonly _tag: "rpc_error";
      readonly code?: string | number | undefined;
      readonly message?: string | undefined;
    };

type CodexProcessFactory = (
  file: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

/** Creates the restricted environment inherited by the Codex child. */
export function allowlistedCodexEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"];
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** Validates that a path is inside the represented worktree without following an escape. */
export async function isPathInsideWorktree(
  worktreePath: string,
  candidatePath: string,
): Promise<boolean> {
  if (isAbsolute(candidatePath) === false && candidatePath.includes(".."))
    return false;
  const [worktree, candidate] = await Promise.all([
    realpath(worktreePath),
    realpath(candidatePath),
  ]).catch(() => ["", ""] as const);
  if (worktree.length === 0 || candidate.length === 0) return false;
  const child = relative(worktree, candidate);
  return (
    child.length === 0 || (!child.startsWith(`..${sep}`) && child !== "..")
  );
}

/** Builds a sanitized Codex child prompt from explicit review facts. */
export function buildCodexPrompt(input: {
  readonly insightType: "analysis" | "walkthrough";
  readonly pullRequestTitle?: string;
  readonly pullRequestDescription?: string;
  readonly reviewInput: string;
  readonly policy: string;
}): Result<string, "invalid_prompt"> {
  const values = [
    input.pullRequestTitle,
    input.pullRequestDescription,
    input.reviewInput,
    input.policy,
  ];
  const unsafe =
    /(?:^|\s)\/[^\s]+|[A-Za-z]:[\\/]|CODEX_HOME|projectReviewCriteria|rulePaths|repository rules|(?:api[_-]?key|access[_-]?token|password|secret|credential|authorization|token)\s*(?:[:=]|\bbearer\b)|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
  if (values.some((value) => value !== undefined && unsafe.test(value)))
    return err("invalid_prompt");
  const prompt = [
    "Patchdesk owns all Review lifecycle, Finding mapping, publication, and merge authority.",
    `Insight type: ${input.insightType}`,
    "The represented review worktree is immutable and read-only. Do not modify files, access credentials, use network, or request permission escalation.",
    "Return exactly one JSON value satisfying the existing Patchdesk result contract. Do not wrap it in Markdown and do not return prose.",
    insightOutputGuidance(input.insightType),
    input.pullRequestTitle === undefined
      ? undefined
      : `Pull request title:\n${input.pullRequestTitle}`,
    input.pullRequestDescription === undefined
      ? undefined
      : `Pull request description:\n${input.pullRequestDescription}`,
    `Review evidence:\n${input.reviewInput}`,
    `Patchdesk policy:\n${input.policy}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES)
    return err("invalid_prompt");
  return ok(prompt);
}

/** Main-process Codex app-server client. Every public operation owns one child and one thread. */
export class CodexAppServerClient {
  private readonly processFactory: CodexProcessFactory;
  private readonly runTimeoutMs: number;

  constructor(
    private readonly executablePath: string,
    options: {
      readonly processFactory?: CodexProcessFactory;
      readonly runTimeoutMs?: number;
    } = {},
  ) {
    this.processFactory =
      options.processFactory ??
      ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
    this.runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
  }

  /** Lists the complete bounded live Codex model catalog using a throwaway child. */
  async listModels(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<ReadonlyArray<CodexModel>, CodexAppServerFailure>> {
    const child = new RpcChild(this.processFactory);
    const started = await child.start(
      this.executablePath,
      undefined,
      options.signal,
    );
    if (started._tag === "err") return started;
    try {
      const deadline = Date.now() + MODEL_DISCOVERY_DEADLINE_MS;
      const models: CodexModel[] = [];
      let bytes = 0;
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        if (options.signal?.aborted)
          return err({ reason: "cancelled", phase: "model_list" });
        if (Date.now() >= deadline)
          return err({ reason: "timed_out", phase: "model_list" });
        const response = await child.request(
          "model/list",
          { includeHidden: false, ...(cursor === undefined ? {} : { cursor }) },
          options.signal,
          deadline - Date.now(),
        );
        if (response._tag === "err")
          return err({
            reason: classifyRpcFailure(response.error),
            phase: "model_list",
          });
        bytes += Buffer.byteLength(JSON.stringify(response.value), "utf8");
        if (bytes > MAX_MODEL_BYTES)
          return err({ reason: "runtime_unavailable", phase: "model_list" });
        const pageModels = parseModelPage(response.value);
        if (pageModels._tag === "err")
          return err({ reason: "invalid_result", phase: "model_list" });
        models.push(...pageModels.value);
        if (models.length > MAX_MODELS)
          return err({ reason: "runtime_unavailable", phase: "model_list" });
        const nextCursor = parseNextCursor(response.value);
        if (nextCursor._tag === "err")
          return err({ reason: "invalid_result", phase: "model_list" });
        if (nextCursor.value === undefined) break;
        if (seenCursors.has(nextCursor.value))
          return err({ reason: "runtime_unavailable", phase: "model_list" });
        seenCursors.add(nextCursor.value);
        cursor = nextCursor.value;
        if (page === MAX_MODEL_PAGES - 1)
          return err({ reason: "runtime_unavailable", phase: "model_list" });
      }
      if (models.length === 0)
        return err({ reason: "runtime_unavailable", phase: "model_list" });
      return ok(models);
    } finally {
      await child.stop();
    }
  }

  /** Runs one strict Analysis or Walkthrough response in a fresh Codex thread. */
  async run(
    input: CodexRunInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<unknown, CodexAppServerFailure>> {
    if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES)
      return err({ reason: "invalid_result", phase: "turn_start" });
    const child = new RpcChild(this.processFactory);
    const started = await child.start(
      this.executablePath,
      input.worktreePath,
      options.signal,
    );
    if (started._tag === "err") return started;
    let resolveTimeout: (
      value: Result<unknown, CodexAppServerFailure>,
    ) => void = () => undefined;
    const timeout = new Promise<Result<unknown, CodexAppServerFailure>>(
      (resolve) => {
        resolveTimeout = resolve;
      },
    );
    const timer = setTimeout(() => {
      child.cancel();
      resolveTimeout(err({ reason: "timed_out", phase: "turn" }));
    }, this.runTimeoutMs);
    try {
      return await Promise.race([
        timeout,
        this.runTurn(child, input, options.signal),
      ]);
    } finally {
      clearTimeout(timer);
      await child.stop();
    }
  }

  private async runTurn(
    child: RpcChild,
    input: CodexRunInput,
    signal?: AbortSignal,
  ): Promise<Result<unknown, CodexAppServerFailure>> {
    const models = await this.listModelsForRun(child, signal);
    if (models._tag === "err") return models;
    const selected = models.value.find(
      (model) =>
        model.id === input.model && model.reasoning.includes(input.reasoning),
    );
    if (selected === undefined)
      return err({ reason: "runtime_unavailable", phase: "model_list" });
    const thread = await child.request(
      "thread/start",
      { model: input.model, cwd: input.worktreePath, sandbox: "read-only" },
      signal,
    );
    if (thread._tag === "err")
      return err({
        reason: classifyRpcFailure(thread.error),
        phase: "thread_start",
      });
    const threadId = readObjectString(thread.value, "thread", "id");
    if (threadId === undefined)
      return err({ reason: "invalid_result", phase: "thread_start" });
    return await child.turn(
      threadId,
      input.prompt,
      input.reasoning,
      input.worktreePath,
      signal,
    );
  }

  private async listModelsForRun(
    child: RpcChild,
    signal?: AbortSignal,
  ): Promise<Result<ReadonlyArray<CodexModel>, CodexAppServerFailure>> {
    const deadline = Date.now() + MODEL_DISCOVERY_DEADLINE_MS;
    const models: CodexModel[] = [];
    let bytes = 0;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      if (signal?.aborted)
        return err({ reason: "cancelled", phase: "model_list" });
      if (Date.now() >= deadline)
        return err({ reason: "timed_out", phase: "model_list" });
      const response = await child.request(
        "model/list",
        { includeHidden: false, ...(cursor === undefined ? {} : { cursor }) },
        signal,
        deadline - Date.now(),
      );
      if (response._tag === "err")
        return err({
          reason: classifyRpcFailure(response.error),
          phase: "model_list",
        });
      bytes += Buffer.byteLength(JSON.stringify(response.value), "utf8");
      if (bytes > MAX_MODEL_BYTES)
        return err({ reason: "runtime_unavailable", phase: "model_list" });
      const parsed = parseModelPage(response.value);
      if (parsed._tag === "err")
        return err({ reason: "invalid_result", phase: "model_list" });
      models.push(...parsed.value);
      if (models.length > MAX_MODELS)
        return err({ reason: "runtime_unavailable", phase: "model_list" });
      const next = parseNextCursor(response.value);
      if (next._tag === "err")
        return err({ reason: "invalid_result", phase: "model_list" });
      if (next.value === undefined) return ok(models);
      if (cursors.has(next.value))
        return err({ reason: "runtime_unavailable", phase: "model_list" });
      cursors.add(next.value);
      cursor = next.value;
    }
    return err({ reason: "runtime_unavailable", phase: "model_list" });
  }
}

class RpcChild {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private child: ChildProcess | undefined;
  private buffer = "";
  private nextId = 0;
  private stopped = false;
  private turnId: string | undefined;
  private threadId: string | undefined;
  private approvalWorktreePath: string | undefined;
  private readonly approvalTasks = new Set<Promise<void>>();

  constructor(private readonly processFactory: CodexProcessFactory) {}

  async start(
    executablePath: string,
    cwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<Result<void, CodexAppServerFailure>> {
    if (signal?.aborted)
      return err({ reason: "cancelled", phase: "initialize" });
    try {
      this.child = this.processFactory(executablePath, ["app-server"], {
        shell: false,
        ...(cwd === undefined ? {} : { cwd }),
        stdio: ["pipe", "pipe", "pipe"],
        env: allowlistedCodexEnvironment(),
      });
      if (
        this.child.stdin === null ||
        this.child.stdout === null ||
        this.child.stderr === null
      ) {
        await this.stop();
        return err({ reason: "runtime_unavailable", phase: "initialize" });
      }
      this.child.stdout.on("data", (chunk: Buffer | string) =>
        this.read(chunk),
      );
      this.child.stderr.on("data", () => undefined);
      this.child.once("error", () => this.failPending());
      this.child.once("exit", () => this.failPending());
      const initialized = await this.request(
        "initialize",
        {
          clientInfo: {
            name: CLIENT_NAME,
            title: "Patchdesk",
            version: CLIENT_VERSION,
          },
        },
        signal,
      );
      if (initialized._tag === "err") {
        await this.stop();
        return err({
          reason: classifyRpcFailure(initialized.error),
          phase: "initialize",
        });
      }
      this.send({ method: "initialized", params: {} });
      return ok(undefined);
    } catch (cause: unknown) {
      await this.stop();
      return err({ reason: classifyThrownFailure(cause), phase: "initialize" });
    }
  }

  async request(
    method: string,
    params: RpcMessage,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Result<RpcMessage, RpcFailure>> {
    if (
      this.child?.stdin === null ||
      this.child?.stdin === undefined ||
      this.stopped
    )
      return err("process_unavailable");
    if (signal?.aborted) return err("cancelled");
    const id = String(++this.nextId);
    return new Promise((resolveResult) => {
      const timer = setTimeout(
        () => {
          const pending = this.pending.get(id);
          if (pending === undefined) return;
          this.pending.delete(id);
          pending.reject("timeout");
        },
        Math.min(REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs)),
      );
      const resolve = (value: RpcMessage): void => {
        clearTimeout(timer);
        resolveResult(ok(value));
      };
      const reject = (cause: RpcFailure): void => {
        clearTimeout(timer);
        resolveResult(err(cause));
      };
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
      const onAbort = (): void => {
        signal?.removeEventListener("abort", onAbort);
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          resolveResult(err("cancelled"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async turn(
    threadId: string,
    prompt: string,
    reasoning: InsightReasoning,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<Result<unknown, CodexAppServerFailure>> {
    this.threadId = threadId;
    this.approvalWorktreePath = worktreePath;
    let text = "";
    let resolveTurn: (
      result: Result<unknown, CodexAppServerFailure>,
    ) => void = () => undefined;
    const finished = new Promise<Result<unknown, CodexAppServerFailure>>(
      (resolve) => {
        resolveTurn = resolve;
      },
    );
    const onMessage = (message: RpcMessage): void => {
      const method = readString(message, "method");
      const params = readObject(message, "params");
      if (method === undefined || params === undefined) return;
      if (method === "item/agentMessage/delta") {
        const delta = readString(params, "delta");
        if (delta !== undefined) text += delta;
        if (Buffer.byteLength(text, "utf8") > MAX_STREAM_BYTES)
          resolveTurn(err({ reason: "invalid_result", phase: "turn" }));
        return;
      }
      if (method === "turn/completed") {
        const turn = readObject(params, "turn");
        const status =
          turn === undefined ? undefined : readString(turn, "status");
        if (status !== "completed") {
          resolveTurn(err({ reason: "execution_failed", phase: "turn" }));
          return;
        }
        try {
          resolveTurn(ok(JSON.parse(text.trim()) as unknown));
        } catch {
          resolveTurn(err({ reason: "invalid_result", phase: "turn" }));
        }
        return;
      }
      if (method === "error")
        resolveTurn(err({ reason: "execution_failed", phase: "turn" }));
    };
    const remove = this.listenersAdd(onMessage);
    const onAbort = (): void => {
      this.cancel();
      resolveTurn(err({ reason: "cancelled", phase: "turn" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const started = await this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          effort: reasoning,
        },
        signal,
      );
      if (started._tag === "err")
        return err({
          reason: classifyRpcFailure(started.error),
          phase: "turn_start",
        });
      this.turnId = readObjectString(started.value, "turn", "id");
      if (this.turnId === undefined)
        return err({ reason: "invalid_result", phase: "turn_start" });
      return await finished;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      remove();
    }
  }

  cancel(): void {
    if (this.threadId !== undefined && this.turnId !== undefined)
      this.send({
        method: "turn/interrupt",
        params: { threadId: this.threadId, turnId: this.turnId },
      });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.cancel();
    await Promise.allSettled([...this.approvalTasks]);
    this.approvalTasks.clear();
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject("stopped");
    }
    this.pending.clear();
    this.listeners.clear();
    this.child?.kill();
    this.child = undefined;
  }

  private listenersAdd(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(message: RpcMessage): void {
    if (
      this.child?.stdin === null ||
      this.child?.stdin === undefined ||
      this.stopped
    )
      return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_STREAM_BYTES) {
      this.failPending();
      return;
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
        )
          this.route(value as RpcMessage);
      } catch {
        this.failPending();
      }
    }
  }

  private route(message: RpcMessage): void {
    const id = readStringOrNumber(message, "id");
    const method = readString(message, "method");
    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(String(id));
      if (pending === undefined) return;
      this.pending.delete(String(id));
      const error = readObject(message, "error");
      if (error !== undefined)
        pending.reject({
          _tag: "rpc_error",
          ...(readStringOrNumber(error, "code") === undefined
            ? {}
            : { code: readStringOrNumber(error, "code") }),
          ...(readString(error, "message") === undefined
            ? {}
            : { message: readString(error, "message") }),
        });
      else {
        const result = readObject(message, "result");
        if (result === undefined) pending.reject("invalid_rpc_result");
        else pending.resolve(result);
      }
      return;
    }
    if (id !== undefined && method !== undefined) {
      const task = this.handleRequest(
        id,
        method,
        readObject(message, "params") ?? {},
      ).catch(() => {
        this.send({ id, result: { decision: "decline" } });
      });
      this.approvalTasks.add(task);
      return;
    }
    if (method !== undefined)
      for (const listener of this.listeners) listener(message);
  }

  private async handleRequest(
    id: string | number,
    method: string,
    params: RpcMessage,
  ): Promise<void> {
    if (method === PERMISSIONS_APPROVAL_METHOD) {
      this.send({ id, result: { permissions: {}, scope: "turn" } });
      return;
    }
    if (method === FILE_APPROVAL_METHOD) {
      this.send({ id, result: { decision: "decline" } });
      return;
    }
    if (method === COMMAND_APPROVAL_METHOD) {
      const worktreePath = readString(params, "cwd");
      const command = readString(params, "command");
      const allowed =
        worktreePath !== undefined &&
        command !== undefined &&
        this.approvalWorktreePath !== undefined &&
        (await isPathInsideWorktree(this.approvalWorktreePath, worktreePath)) &&
        (await this.isReadOnlyCommand(command, this.approvalWorktreePath));
      this.send({ id, result: { decision: allowed ? "accept" : "decline" } });
      return;
    }
    this.send({ id, error: { code: -32601, message: "unsupported_request" } });
  }

  private async isReadOnlyCommand(
    command: string,
    worktreePath: string,
  ): Promise<boolean> {
    if (
      command.length === 0 ||
      command.length > 4_096 ||
      /[;&|><`$\n\r]/.test(command)
    )
      return false;
    const tokens = command.trim().split(/\s+/u);
    const executable = tokens[0];
    if (
      executable === undefined ||
      executable.includes("/") ||
      ![
        "cat",
        "head",
        "tail",
        "sed",
        "grep",
        "rg",
        "find",
        "git",
        "pwd",
        "wc",
      ].includes(executable)
    )
      return false;
    if (
      tokens.some(
        (token) =>
          token.startsWith("-") ||
          token.startsWith("/") ||
          token.split("/").includes(".."),
      )
    )
      return false;
    if (
      executable === "git" &&
      !["show", "diff", "status", "log", "ls-files", "rev-parse"].includes(
        tokens[1] ?? "",
      )
    )
      return false;
    if (executable === "git" && tokens.length > 2) return false;
    if (executable === "pwd" && tokens.length !== 1) return false;
    for (const token of tokens.slice(executable === "git" ? 2 : 1)) {
      if (
        !(await isPathInsideWorktree(worktreePath, join(worktreePath, token)))
      )
        return false;
    }
    return true;
  }

  private failPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject("process_failed");
    }
    this.pending.clear();
  }
}

function parseModelPage(
  input: RpcMessage,
): Result<ReadonlyArray<CodexModel>, "invalid_models"> {
  const data = readArray(input, "data");
  if (data === undefined) return err("invalid_models");
  const models: CodexModel[] = [];
  let bytes = 0;
  for (const item of data) {
    const id = readString(item, "id");
    if (id === undefined || id.length > 200) return err("invalid_models");
    bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > MAX_MODEL_BYTES) return err("invalid_models");
    if (item.hidden === true) continue;
    const efforts: Array<InsightReasoning> =
      readArray(item, "supportedReasoningEfforts")?.flatMap(
        (effort): ReadonlyArray<InsightReasoning> => {
          const value = readString(effort, "reasoningEffort");
          if (value === "minimal") return ["minimal"];
          if (value === "low") return ["low"];
          if (value === "medium") return ["medium"];
          if (value === "high") return ["high"];
          if (value === "xhigh") return ["xhigh"];
          return [];
        },
      ) ?? [];
    if (efforts.length === 0) continue;
    const defaultValue = readString(item, "defaultReasoningEffort");
    const defaultReasoning =
      defaultValue === "minimal" ||
      defaultValue === "low" ||
      defaultValue === "medium" ||
      defaultValue === "high" ||
      defaultValue === "xhigh"
        ? defaultValue
        : undefined;
    models.push({
      id,
      label: readString(item, "displayName") ?? id,
      reasoning: [...new Set(efforts)],
      ...(defaultReasoning === undefined ? {} : { defaultReasoning }),
    });
  }
  return ok(models);
}

/** Parses Codex's optional pagination cursor; its app server sends null at the final page. */
function parseNextCursor(
  input: RpcMessage,
): Result<string | undefined, "invalid_cursor"> {
  const value = input.nextCursor;
  if (value === undefined || value === null) return ok(undefined);
  return typeof value === "string" ? ok(value) : err("invalid_cursor");
}

function readObject(input: RpcMessage, key: string): RpcMessage | undefined {
  const value = input[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RpcMessage)
    : undefined;
}
function readArray(
  input: RpcMessage,
  key: string,
): ReadonlyArray<RpcMessage> | undefined {
  const value = input[key];
  return Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    ? (value as ReadonlyArray<RpcMessage>)
    : undefined;
}
function readString(input: RpcMessage, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}
function readObjectString(
  input: RpcMessage,
  objectKey: string,
  key: string,
): string | undefined {
  const object = readObject(input, objectKey);
  return object === undefined ? undefined : readString(object, key);
}
function readStringOrNumber(
  input: RpcMessage,
  key: string,
): string | number | undefined {
  const value = input[key];
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}
function classifyThrownFailure(cause: unknown): InsightFailureCategory {
  if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
    return "runtime_unavailable";
  return "execution_failed";
}
function classifyRpcFailure(
  cause: RpcFailure,
): InsightFailureCategory | "cancelled" {
  if (cause === "cancelled") return "cancelled";
  if (cause === "timeout") return "timed_out";
  if (typeof cause === "object") {
    const detail = `${cause.code ?? ""} ${cause.message ?? ""}`.toLowerCase();
    if (detail.includes("login") || detail.includes("auth"))
      return "authentication_required";
    if (detail.includes("rate") || detail.includes("concurren"))
      return "rate_limited";
    if (detail.includes("timeout")) return "timed_out";
    if (detail.includes("cancel")) return "cancelled";
    if (detail.includes("invalid")) return "invalid_result";
  }
  return "execution_failed";
}
