import {
  runCodexExplanation,
  type CodexExplanationInput,
} from "./codex-explanation-session";
import type { ExplanationProducerOutcome } from "#src/services/explanation-producer";
import {
  RpcChild,
  classifyRpcFailure,
  type CodexProcessFactory,
} from "./codex-app-server-rpc";
import { paginateModelList, type CodexModel } from "./codex-model-catalog";
export type { CodexRpcMessage, JsonObject } from "./codex-app-server-rpc";
export type { CodexModel } from "./codex-model-catalog";
import type { CodexRpcMessage } from "./codex-app-server-rpc";
export type CodexInsightRpc = Pick<RpcChild, "start" | "request" | "stop"> & {
  readonly nativeVersion?: string | undefined;
};
const plainObjectSchema = v.looseObject({});
import {
  insightFailureDiagnostic,
  type InsightFailureDiagnostic,
} from "#src/domain/insight-failure-diagnostic";
export { buildCodexAnalysisPrompt } from "./codex-analysis-prompt";
import { spawn } from "node:child_process";
import * as v from "valibot";
import {
  createCodexInsightHome,
  withCodexInsightHome,
  withCodexInsightProcessCleanup,
  discoverCodexInsightSession,
  validateCodexInsightSession,
  type CodexInsightSession,
  type CodexInsightHome,
  type CodexInsightHomeFactory,
} from "./codex-insight-home";
import type { JsonSchema } from "@valibot/to-json-schema";

import { err, ok, type Result } from "#src/domain/result";
import type { InsightReasoning } from "#src/domain/insight-provider";
import type { RepresentedReviewWorktree } from "#src/domain/represented-review-worktree";
import type { InsightFailureCategory } from "#src/domain/insight-record";

import { createCodexActivityEmitter } from "./codex-activity";
import type { InsightActivitySink } from "./codex-activity";

import {
  NATIVE_INSIGHT_PROMPT_BYTES,
  codexInsightIsolationArgs,
  parseCodexInsightThread,
} from "./codex-insight-policy";

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
/** Hard bound for one composed Analysis prompt; mirrors MAX_ANALYSIS_PROMPT_BYTES in model-review-runner.ts. */
export const MAX_ANALYSIS_CODEX_PROMPT_BYTES = NATIVE_INSIGHT_PROMPT_BYTES;
const RUN_TIMEOUT_MS = 5 * 60_000;

/** Shared unsafe-prompt guard: rejects path disclosure, credential leakage, and repository-rule leakage. */
export const UNSAFE_PROMPT_PATTERN =
  /(?:^|\s)\/[^\s]+|[A-Za-z]:[\\/]|CODEX_HOME|projectReviewCriteria|rulePaths|repository rules|(?:api[_-]?key|access[_-]?token|password|secret|credential|authorization|token)\s*(?:[:=]|\bbearer\b)|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;

/** Typed failures returned by the Codex process adapter. */
export type CodexAppServerFailure = InsightFailureDiagnostic & {
  readonly reason:
    | Exclude<
        InsightFailureCategory,
        "evidence_unavailable" | "evidence_mismatch" | "analysis_incomplete"
      >
    | "cancelled";
  readonly phase:
    | "resolve"
    | "initialize"
    | "model_list"
    | "thread_start"
    | "turn_start"
    | "turn"
    | "approval"
    | "cleanup"
    | "native_isolation_unsupported"
    | "native_policy_unsupported"
    | "native_auth_unsupported";
};

/** An app-owned immutable worktree and sanitized prompt bound to one run. */
export type CodexRunInput = {
  readonly worktreePath: RepresentedReviewWorktree;
  readonly expectedHeadSha: string;
  readonly model: string;
  readonly reasoning: InsightReasoning;
  readonly prompt: string;
  readonly outputSchema?: JsonSchema;
  readonly maxPromptBytes?: number;
  readonly runTimeoutMs?: number;
};

const turnStartResultSchema = v.looseObject({
  turn: v.looseObject({ id: v.string() }),
});
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
  private readonly homeFactory: CodexInsightHomeFactory;

  constructor(
    private readonly executablePath: string,
    options: {
      readonly processFactory?: CodexProcessFactory;
      readonly runTimeoutMs?: number;
      readonly homeFactory?: CodexInsightHomeFactory;
    } = {},
  ) {
    this.processFactory =
      options.processFactory ??
      ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
    this.runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
    this.homeFactory = options.homeFactory ?? createCodexInsightHome;
  }

  /** Runs logical explanation tools through the native lifecycle, with no strict final result. */
  runExplanation(
    input: CodexExplanationInput,
  ): Promise<ExplanationProducerOutcome> {
    return runCodexExplanation(
      this.executablePath,
      this.processFactory,
      this.homeFactory,
      input,
    );
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
      return await paginateModelList(child, options.signal);
    } finally {
      await child.stop();
    }
  }

  /** Runs one strict Insight response in a fresh Codex thread; `onActivity` observes its commands and reasoning. */
  async run(
    input: CodexRunInput,
    options: {
      readonly signal?: AbortSignal;
      readonly onActivity?: InsightActivitySink | undefined;
    } = {},
  ): Promise<Result<unknown, CodexAppServerFailure>> {
    const maxPromptBytes = Math.min(
      input.maxPromptBytes ?? MAX_PROMPT_BYTES,
      NATIVE_INSIGHT_PROMPT_BYTES,
    );
    if (Buffer.byteLength(input.prompt, "utf8") > maxPromptBytes)
      return err({ reason: "invalid_result", phase: "turn_start" });
    if (options.signal?.aborted)
      return err({ reason: "cancelled", phase: "initialize" });
    const result = await withCodexInsightHome(
      this.homeFactory,
      input.runTimeoutMs ?? this.runTimeoutMs,
      (home) => this.runWithHome(input, options, home),
      options.signal,
    );
    return result._tag === "err"
      ? err({
          ...result.error,
          ...insightFailureDiagnostic(
            result.error.reason,
            result.error.phase,
            result.error.detail,
          ),
          phase: result.error.phase,
        })
      : result;
  }

  private async runWithHome(
    input: CodexRunInput,
    options: {
      readonly signal?: AbortSignal;
      readonly onActivity?: InsightActivitySink | undefined;
    },
    home: CodexInsightHome,
  ): Promise<Result<unknown, CodexAppServerFailure>> {
    const isolation = await discoverCodexInsightSession(
      () => new RpcChild(this.processFactory),
      this.executablePath,
      input.worktreePath,
      home,
      options.signal,
    );
    if (isolation._tag === "err") return isolation;
    const child = new RpcChild(this.processFactory);
    const started = await child.start(
      this.executablePath,
      input.worktreePath,
      options.signal,
      [...codexInsightIsolationArgs(), ...isolation.value.args],
      home.directory,
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
    return await withCodexInsightProcessCleanup(
      () =>
        Promise.race([
          timeout,
          this.runTurn(
            child,
            input,
            home,
            isolation.value,
            options.signal,
            options.onActivity,
          ),
        ]),
      () => {
        clearTimeout(timer);
        return child.stop();
      },
    );
  }

  private async runTurn(
    child: RpcChild,
    input: CodexRunInput,
    home: CodexInsightHome,
    expected: CodexInsightSession,
    signal?: AbortSignal,
    onActivity?: InsightActivitySink,
  ): Promise<Result<unknown, CodexAppServerFailure>> {
    const validated = await validateCodexInsightSession(
      child,
      input.worktreePath,
      home,
      expected,
      signal,
    );
    if (validated._tag === "err") return validated;
    const models = await paginateModelList(child, signal);
    if (models._tag === "err") return models;
    const selected = models.value.find(
      (model) =>
        model.id === input.model && model.reasoning.includes(input.reasoning),
    );
    if (selected === undefined)
      return err({ reason: "runtime_unavailable", phase: "model_list" });
    const thread = await child.request(
      "thread/start",
      // Native automatic review owns permission decisions; managed requirements can refuse this policy.
      {
        model: input.model,
        cwd: input.worktreePath,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        config: { model_reasoning_effort: input.reasoning },
        developerInstructions: "",
        ephemeral: true,
      },
      signal,
    );
    if (thread._tag === "err")
      return err({
        reason: classifyRpcFailure(thread.error),
        phase: "thread_start",
      });
    const threadId = parseCodexInsightThread(thread.value, input);
    if (threadId === undefined)
      return err({
        reason: "runtime_unavailable",
        phase: "native_policy_unsupported",
      });
    if (!(await home.unchanged(input.runTimeoutMs ?? this.runTimeoutMs)))
      return err({
        reason: "runtime_unavailable",
        phase: "native_auth_unsupported",
      });
    return await strictCodexTurn(
      child,
      threadId,
      input.prompt,
      input.reasoning,
      input.worktreePath,
      input.outputSchema,
      signal,
      onActivity,
    );
  }
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

async function strictCodexTurn(
  child: RpcChild,
  threadId: string,
  prompt: string,
  reasoning: InsightReasoning,
  worktreePath: string,
  outputSchema: JsonSchema | undefined,
  signal?: AbortSignal,
  onActivity?: InsightActivitySink,
): Promise<Result<unknown, CodexAppServerFailure>> {
  child.bindTurn(threadId);
  const activity = createCodexActivityEmitter(onActivity, worktreePath);
  child.activity = activity;
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
    activity.notification(message);
    if (method === "item/agentMessage/delta") {
      const deltaParsed = v.safeParse(agentMessageDeltaParamsSchema, params);
      const delta = deltaParsed.success ? deltaParsed.output.delta : undefined;
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
  const remove = child.listenersAdd(onMessage);
  const onAbort = (): void => {
    child.cancel();
    resolveTurn(err({ reason: "cancelled", phase: "turn" }));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    activity.turnStarted();
    const started = await child.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        effort: reasoning,
        outputSchema,
      },
      signal,
    );
    if (started._tag === "err")
      return err({
        reason: classifyRpcFailure(started.error),
        phase: "turn_start",
      });
    const startedParsed = v.safeParse(turnStartResultSchema, started.value);
    const turnId = startedParsed.success
      ? startedParsed.output.turn.id
      : undefined;
    if (turnId === undefined)
      return err({ reason: "invalid_result", phase: "turn_start" });
    child.bindTurn(threadId, turnId);
    return await finished;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    remove();
  }
}
