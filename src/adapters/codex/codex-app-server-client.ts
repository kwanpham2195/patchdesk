import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import * as v from "valibot";

import { err, ok, type Result } from "../../domain/result";
import type { InsightReasoning } from "../../domain/insight-provider";
import type { RepresentedReviewWorktree } from "../../domain/represented-review-worktree";
import type { InsightFailureCategory } from "../../domain/insight-record";
import { isPathContained } from "../storage/path-containment";

const CLIENT_NAME = "patchdesk";
const CLIENT_VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_DISCOVERY_DEADLINE_MS = 30_000;
const MAX_MODEL_PAGES = 50;
const MAX_MODELS = 512;
const MAX_MODEL_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_WALKTHROUGH_PROMPT_BYTES = 3 * 1024 * 1024;
/** Hard bound for one composed Analysis prompt; mirrors MAX_ANALYSIS_PROMPT_BYTES in model-review-runner.ts. */
export const MAX_ANALYSIS_CODEX_PROMPT_BYTES = 6 * 1024 * 1024;
const RUN_TIMEOUT_MS = 5 * 60_000;

/** Shared unsafe-prompt guard: rejects path disclosure, credential leakage, and repository-rule leakage. */
const UNSAFE_PROMPT_PATTERN =
  /(?:^|\s)\/[^\s]+|[A-Za-z]:[\\/]|CODEX_HOME|projectReviewCriteria|rulePaths|repository rules|(?:api[_-]?key|access[_-]?token|password|secret|credential|authorization|token)\s*(?:[:=]|\bbearer\b)|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;

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
  readonly maxPromptBytes?: number;
  readonly runTimeoutMs?: number;
};

type PendingRequest = {
  readonly resolve: (value: JsonObject) => void;
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

/**
 * One line of the Codex app-server's stdio protocol, either direction: a response, a
 * server-to-client request, or a notification. `params`/`result`/`error` are left as `unknown`
 * here and parsed into their method-specific shape at the point each is consumed, so one
 * malformed field never invalidates the whole envelope.
 */
export const codexRpcMessageSchema = v.looseObject({
  id: v.optional(v.union([v.string(), v.number()])),
  method: v.optional(v.string()),
  params: v.optional(v.unknown()),
  result: v.optional(v.unknown()),
  error: v.optional(v.unknown()),
});
export type CodexRpcMessage = v.InferOutput<typeof codexRpcMessageSchema>;

/** The `id`+`method`+`params` and `id`+`result`/`error` shapes this client writes to the child. */
type OutgoingRpcMessage =
  | { readonly method: string; readonly params: unknown }
  | { readonly id: string; readonly method: string; readonly params: unknown }
  | { readonly id: string | number; readonly result: unknown }
  | {
      readonly id: string | number;
      readonly error: { readonly code: number; readonly message: string };
    };

const rpcErrorSchema = v.looseObject({
  code: v.optional(v.union([v.string(), v.number()])),
  message: v.optional(v.string()),
});

/** Bare "is a plain object" gate for a field the wire protocol leaves as `unknown`. */
const plainObjectSchema = v.looseObject({});

/**
 * A generic JSON value. Every RPC response's `result` is one of these before it is parsed into
 * its own method-specific shape (thread/start, turn/start, model/list, ...); each caller runs
 * its own schema over it rather than reading it as `unknown`.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };
const jsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null_(),
    v.array(jsonValueSchema),
    v.record(v.string(), jsonValueSchema),
  ]),
);
/** An RPC response's `result`, confirmed to be a plain object. */
const jsonObjectSchema = v.record(v.string(), jsonValueSchema);
type JsonObject = v.InferOutput<typeof jsonObjectSchema>;

const threadStartResultSchema = v.looseObject({
  thread: v.looseObject({ id: v.string() }),
});
const turnStartResultSchema = v.looseObject({
  turn: v.looseObject({ id: v.string() }),
});
const modelListItemSchema = v.looseObject({
  id: v.string(),
  displayName: v.optional(v.string()),
  hidden: v.optional(v.boolean()),
  supportedReasoningEfforts: v.optional(
    v.array(v.looseObject({ reasoningEffort: v.optional(v.string()) })),
  ),
  defaultReasoningEffort: v.optional(v.string()),
});
const modelListResultSchema = v.looseObject({
  data: v.array(modelListItemSchema),
  nextCursor: v.optional(v.nullable(v.string())),
});
type ModelListItem = v.InferOutput<typeof modelListItemSchema>;

const turnItemSchema = v.looseObject({
  type: v.optional(v.string()),
  text: v.optional(v.string()),
});
const completedTurnSchema = v.looseObject({
  status: v.optional(v.string()),
  // A malformed `items` array must not sink `status`: the caller falls back to
  // the streamed delta text when items can't be read, same as an absent field.
  items: v.fallback(v.optional(v.array(turnItemSchema)), undefined),
});
type CompletedTurn = v.InferOutput<typeof completedTurnSchema>;
const turnCompletedParamsSchema = v.looseObject({
  turn: v.optional(completedTurnSchema),
});
const agentMessageDeltaParamsSchema = v.looseObject({
  delta: v.optional(v.string()),
});
const commandApprovalParamsSchema = v.looseObject({
  cwd: v.optional(v.string()),
  command: v.optional(v.string()),
});
type CommandApprovalParams = v.InferOutput<typeof commandApprovalParamsSchema>;

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
  return isPathContained(worktree, candidate);
}

/** The Analysis result contract Codex must return, kept faithful to modelReviewResultSchema. */
const ANALYSIS_RESULT_CONTRACT = [
  '{"changeSummary":string,"verdict":"approve"|"comment"|"request_changes","summary":string,',
  ' "findings":[{"id":string,"severity":"P0"|"P1"|"P2"|"P3","title":string,"explanation":string,',
  '   "confidence":"high"|"medium"|"low","file"?:string,"lineStart"?:number,"lineEnd"?:number,',
  '   "diffSide"?:"new"|"old","suggestedComment"?:string,',
  '   "category"?:"bug"|"security"|"test"|"performance"|"maintainability"|"docs",',
  '   "affectedScenario"?:string,"whyItMatters"?:string,"suggestedChange"?:string}],',
  ' "validationPlan":[string],"assumptions":[string],',
  ' "coverage"?:"high"|"medium"|"low","overallConfidence"?:"high"|"medium"|"low",',
  ' "unresolvedItems"?:[string],',
  ' "callouts"?:[{"category":"migration"|"dependency"|"dependency_change"|"authentication"|"compatibility"|"destructive_operation"|"feature_flag"|"configuration","title":string,"detail":string,"path"?:string}]}',
].join("\n");

/**
 * Builds a sanitized Codex child prompt for an Analysis. `analysisPrompt` carries the app-owned
 * immutable patch and context artifacts, so the unsafe-content guard applies only to `policy`:
 * applying it to the patch would reject ordinary code such as ` /**`.
 */
export function buildCodexAnalysisPrompt(input: {
  readonly analysisPrompt: string;
  readonly policy: string;
}): Result<string, "invalid_prompt"> {
  if (UNSAFE_PROMPT_PATTERN.test(input.policy)) return err("invalid_prompt");
  const prompt = [
    "Patchdesk owns all Review lifecycle, Finding mapping, publication, and merge authority.",
    "Insight type: analysis",
    "The represented review worktree is immutable and read-only. Do not modify files, access credentials, use network, or request permission escalation.",
    "Return exactly one JSON object satisfying the result contract below. Do not wrap it in a Markdown code fence, and do not add any prose before or after it. Use no keys beyond those listed.",
    ANALYSIS_RESULT_CONTRACT,
    "The verdict must match the findings: use request_changes when any finding is P0 or P1, comment when there are findings but none are P0 or P1, and approve only when findings is empty. A mismatch fails the whole run.",
    "Give each finding an id that matches ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ and is unique among the findings.",
    "Give each finding's file a repo-relative path taken from the patch. Never use an absolute path or a path that contains '..'.",
    "Use at most 50 findings. Use at most 20 validationPlan entries and at most 20 assumptions, each within 500 characters. Use at most 10 unresolvedItems, each within 280 characters. Use at most 12 callouts; each callouts entry is an object, never a string, with title within 120 characters and detail within 500 characters.",
    "Give changeSummary, summary, and every finding's title and explanation a non-empty value.",
    input.analysisPrompt,
    `Patchdesk policy:\n${input.policy}`,
  ].join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_ANALYSIS_CODEX_PROMPT_BYTES)
    return err("invalid_prompt");
  return ok(prompt);
}

/**
 * Builds a sanitized Codex child prompt for a Walkthrough. `walkthroughPrompt` carries the
 * app-owned immutable patch and context artifacts, so the unsafe-content guard applies only to
 * `policy`: applying it to the patch would reject ordinary code such as ` /**`.
 */
export function buildCodexWalkthroughPrompt(input: {
  readonly walkthroughPrompt: string;
  readonly policy: string;
}): Result<string, "invalid_prompt"> {
  if (UNSAFE_PROMPT_PATTERN.test(input.policy)) return err("invalid_prompt");
  const prompt = [
    "Patchdesk owns all Review lifecycle, Finding mapping, publication, and merge authority.",
    "Insight type: walkthrough",
    "The represented review worktree is immutable and read-only. Do not modify files, access credentials, use network, or request permission escalation.",
    "Return exactly one JSON object. Do not wrap it in a Markdown code fence, and do not add any prose before or after it.",
    '{"citationVersion":2,"title":string,"focus":string,"chapters":[{"title":string,"sections":[{"title":string,"prose":string,"hunkIds":[string]}]}]}',
    "Use no other keys. Use at most 12 chapters and at most 32 sections in total. Keep title within 200 characters, focus within 320, each chapter title within 80, each section title within 160, and each section prose within 320.",
    "Every entry in hunkIds must be an alias from the supplied HUNK ALIAS MANIFEST, and each section's prose must contain the exact repo-relative path of every hunk it cites. A section whose citations fail this rule is discarded.",
    input.walkthroughPrompt,
    `Patchdesk policy:\n${input.policy}`,
  ].join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_WALKTHROUGH_PROMPT_BYTES)
    return err("invalid_prompt");
  return ok(prompt);
}

/** Parses a Codex turn's completed text, tolerating a fenced ```json (or ```) reply. */
export function parseTurnJson(text: string): Result<unknown, "invalid_json"> {
  const trimmed = text.trim();
  const body = trimmed.startsWith("```") ? stripCodeFence(trimmed) : trimmed;
  try {
    // SAFETY: JSON.parse's declared return type is `any`; asserting it to `unknown` re-establishes
    // the parsed-boundary contract instead of letting an implicit `any` leak into the caller.
    return ok(JSON.parse(body) as unknown);
  } catch {
    return err("invalid_json");
  }
}

function stripCodeFence(text: string): string {
  const withoutOpening = text.replace(/^```[^\n]*\n?/, "");
  return withoutOpening.endsWith("```")
    ? withoutOpening.slice(0, -3).trim()
    : withoutOpening.trim();
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
        const params =
          cursor === undefined
            ? { includeHidden: false }
            : { includeHidden: false, cursor };
        const response = await child.request(
          "model/list",
          params,
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
        const parsedResult = v.safeParse(modelListResultSchema, response.value);
        if (!parsedResult.success)
          return err({ reason: "invalid_result", phase: "model_list" });
        const pageModels = parseModelPage(parsedResult.output.data);
        if (pageModels._tag === "err")
          return err({ reason: "invalid_result", phase: "model_list" });
        models.push(...pageModels.value);
        if (models.length > MAX_MODELS)
          return err({ reason: "runtime_unavailable", phase: "model_list" });
        const nextCursor = parsedResult.output.nextCursor ?? undefined;
        if (nextCursor === undefined) break;
        if (seenCursors.has(nextCursor))
          return err({ reason: "runtime_unavailable", phase: "model_list" });
        seenCursors.add(nextCursor);
        cursor = nextCursor;
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
    const maxPromptBytes = input.maxPromptBytes ?? MAX_PROMPT_BYTES;
    if (Buffer.byteLength(input.prompt, "utf8") > maxPromptBytes)
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
    }, input.runTimeoutMs ?? this.runTimeoutMs);
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
    const threadParsed = v.safeParse(threadStartResultSchema, thread.value);
    const threadId = threadParsed.success
      ? threadParsed.output.thread.id
      : undefined;
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
      const params =
        cursor === undefined
          ? { includeHidden: false }
          : { includeHidden: false, cursor };
      const response = await child.request(
        "model/list",
        params,
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
      const parsedResult = v.safeParse(modelListResultSchema, response.value);
      if (!parsedResult.success)
        return err({ reason: "invalid_result", phase: "model_list" });
      const parsed = parseModelPage(parsedResult.output.data);
      if (parsed._tag === "err")
        return err({ reason: "invalid_result", phase: "model_list" });
      models.push(...parsed.value);
      if (models.length > MAX_MODELS)
        return err({ reason: "runtime_unavailable", phase: "model_list" });
      const next = parsedResult.output.nextCursor ?? undefined;
      if (next === undefined) return ok(models);
      if (cursors.has(next))
        return err({ reason: "runtime_unavailable", phase: "model_list" });
      cursors.add(next);
      cursor = next;
    }
    return err({ reason: "runtime_unavailable", phase: "model_list" });
  }
}

class RpcChild {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(message: CodexRpcMessage) => void>();
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
      const spawnOptions: SpawnOptions = {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: allowlistedCodexEnvironment(),
      };
      this.child = this.processFactory(
        executablePath,
        ["app-server"],
        cwd === undefined ? spawnOptions : { ...spawnOptions, cwd },
      );
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

  async request<P>(
    method: string,
    params: P,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Result<JsonObject, RpcFailure>> {
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
      const resolve = (value: JsonObject): void => {
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
    const onMessage = (message: CodexRpcMessage): void => {
      const { method, params } = message;
      if (method === undefined || !v.is(plainObjectSchema, params)) return;
      if (method === "item/agentMessage/delta") {
        const deltaParsed = v.safeParse(agentMessageDeltaParamsSchema, params);
        const delta = deltaParsed.success
          ? deltaParsed.output.delta
          : undefined;
        if (delta !== undefined) text += delta;
        if (Buffer.byteLength(text, "utf8") > MAX_STREAM_BYTES)
          resolveTurn(err({ reason: "invalid_result", phase: "turn" }));
        return;
      }
      if (method === "turn/completed") {
        const turnParsed = v.safeParse(turnCompletedParamsSchema, params);
        const turn = turnParsed.success ? turnParsed.output.turn : undefined;
        if (turn?.status !== "completed") {
          resolveTurn(err({ reason: "execution_failed", phase: "turn" }));
          return;
        }
        // The completed turn carries the authoritative final message; the
        // protocol does not guarantee that every message arrives as a delta.
        const answer = finalAgentMessageText(turn) ?? text;
        const parsed = parseTurnJson(answer);
        resolveTurn(
          parsed._tag === "ok"
            ? ok(parsed.value)
            : err({ reason: "invalid_result", phase: "turn" }),
        );
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
      const startedParsed = v.safeParse(turnStartResultSchema, started.value);
      this.turnId = startedParsed.success
        ? startedParsed.output.turn.id
        : undefined;
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

  private listenersAdd(
    listener: (message: CodexRpcMessage) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(message: OutgoingRpcMessage): void {
    if (
      this.child?.stdin === null ||
      this.child?.stdin === undefined ||
      this.stopped
    )
      return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: Buffer | string): void {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_STREAM_BYTES) {
      this.failPending();
      return;
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.failPending();
        continue;
      }
      const parsed = v.safeParse(codexRpcMessageSchema, value);
      if (parsed.success) this.route(parsed.output);
    }
  }

  private route(message: CodexRpcMessage): void {
    const { id, method } = message;
    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(String(id));
      if (pending === undefined) return;
      this.pending.delete(String(id));
      const errorParsed = v.safeParse(rpcErrorSchema, message.error);
      if (errorParsed.success) {
        const { code, message: errorMessage } = errorParsed.output;
        const base = { _tag: "rpc_error" as const };
        const withCode = code === undefined ? base : { ...base, code };
        const rpcError =
          errorMessage === undefined
            ? withCode
            : { ...withCode, message: errorMessage };
        pending.reject(rpcError);
      } else {
        const result = message.result;
        if (result === undefined || !v.is(jsonObjectSchema, result))
          pending.reject("invalid_rpc_result");
        else pending.resolve(result);
      }
      return;
    }
    if (id !== undefined && method !== undefined) {
      const commandParamsParsed = v.safeParse(
        commandApprovalParamsSchema,
        message.params,
      );
      const task = this.handleRequest(
        id,
        method,
        commandParamsParsed.success ? commandParamsParsed.output : undefined,
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
    commandParams: CommandApprovalParams | undefined,
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
      const worktreePath = commandParams?.cwd;
      const command = commandParams?.command;
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
  data: ReadonlyArray<ModelListItem>,
): Result<ReadonlyArray<CodexModel>, "invalid_models"> {
  const models: CodexModel[] = [];
  let bytes = 0;
  for (const item of data) {
    if (item.id.length > 200) return err("invalid_models");
    bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > MAX_MODEL_BYTES) return err("invalid_models");
    if (item.hidden === true) continue;
    const efforts: Array<InsightReasoning> =
      item.supportedReasoningEfforts?.flatMap(
        (effort): ReadonlyArray<InsightReasoning> => {
          const value = effort.reasoningEffort;
          if (value === "minimal") return ["minimal"];
          if (value === "low") return ["low"];
          if (value === "medium") return ["medium"];
          if (value === "high") return ["high"];
          if (value === "xhigh") return ["xhigh"];
          return [];
        },
      ) ?? [];
    if (efforts.length === 0) continue;
    const defaultValue = item.defaultReasoningEffort;
    const defaultReasoning =
      defaultValue === "minimal" ||
      defaultValue === "low" ||
      defaultValue === "medium" ||
      defaultValue === "high" ||
      defaultValue === "xhigh"
        ? defaultValue
        : undefined;
    const model: CodexModel = {
      id: item.id,
      label: item.displayName ?? item.id,
      reasoning: [...new Set(efforts)],
    };
    models.push(
      defaultReasoning === undefined ? model : { ...model, defaultReasoning },
    );
  }
  return ok(models);
}

/** Reads the authoritative final agent message from a completed turn payload. */
function finalAgentMessageText(
  turn: CompletedTurn | undefined,
): string | undefined {
  if (turn?.items === undefined) return undefined;
  let answer: string | undefined;
  for (const item of turn.items) {
    if (item.type !== "agentMessage") continue;
    if (
      item.text !== undefined &&
      Buffer.byteLength(item.text, "utf8") <= MAX_STREAM_BYTES
    )
      answer = item.text;
  }
  return answer;
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
  if (
    cause !== "process_unavailable" &&
    cause !== "process_failed" &&
    cause !== "stopped" &&
    cause !== "invalid_rpc_result"
  ) {
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
