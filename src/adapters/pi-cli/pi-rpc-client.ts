import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import * as v from "valibot";

import { err, ok, type Result } from "../../domain/result";
import type { InsightReasoning } from "../../domain/insight-provider";
import type { InsightFailureCategory } from "../../domain/insight-record";
import type { RepresentedReviewWorktree } from "../../domain/represented-review-worktree";
import { parseTurnJson } from "../codex/codex-app-server-client";
import {
  PiRpcChannel,
  type PiProcessFactory,
  type PiRpcRequestFailure,
} from "./pi-rpc-channel";

/**
 * The oldest pi this client drives: 0.79.0 added `--no-approve` and 0.80.4
 * added the `agent_settled` event a run waits for.
 */
export const PI_CLI_MINIMUM_VERSION = "0.80.4";
const MINIMUM_VERSION_PARTS = [0, 80, 4] as const;
/** pi's built-in read-only tools; `--tools` also allowlists extension and custom tools by name. */
const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const VERSION_TIMEOUT_MS = 10_000;
const MODEL_LIST_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_MODELS = 2048;
const MAX_MODEL_ID_CHARS = 200;
const MAX_PROMPT_BYTES = 256 * 1024;
/** Levels Patchdesk offers, in pi's order; pi's `off` and `max` have no Insight equivalent. */
const INSIGHT_REASONING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies ReadonlyArray<InsightReasoning>;

/** A model the pi login can run, keyed `provider/id` as `--model` accepts it. */
export type PiCliModel = {
  readonly id: string;
  readonly label: string;
  readonly reasoning: ReadonlyArray<InsightReasoning>;
  readonly defaultReasoning?: InsightReasoning;
};

/** Typed failures returned by the pi RPC adapter. */
export type PiRpcFailure = {
  readonly reason: InsightFailureCategory | "cancelled";
  readonly phase:
    | "version"
    | "start"
    | "model_list"
    | "session_state"
    | "prompt"
    | "tool"
    | "turn";
  /** Set when the installed pi is older than `PI_CLI_MINIMUM_VERSION`. */
  readonly requiredVersion?: string;
};

/** An app-owned immutable worktree and prompt bound to one run. pi has no output-schema channel, so the prompt carries the result contract. */
export type PiRpcRunInput = {
  readonly worktreePath: RepresentedReviewWorktree;
  readonly model: string;
  readonly reasoning: InsightReasoning;
  readonly prompt: string;
  readonly maxPromptBytes?: number;
  readonly runTimeoutMs?: number;
};

const piModelSchema = v.looseObject({
  id: v.string(),
  provider: v.string(),
  reasoning: v.optional(v.boolean()),
  thinkingLevelMap: v.optional(
    v.nullable(v.record(v.string(), v.nullable(v.unknown()))),
  ),
});
type PiModelEntry = v.InferOutput<typeof piModelSchema>;
/** A malformed entry becomes `undefined` and is skipped, so one odd custom model never hides the rest. */
const modelListDataSchema = v.looseObject({
  models: v.array(v.fallback(v.optional(piModelSchema), undefined)),
});
const sessionStateSchema = v.looseObject({
  model: v.optional(v.looseObject({ id: v.string(), provider: v.string() })),
  thinkingLevel: v.optional(v.string()),
});
const assistantMessageSchema = v.looseObject({
  role: v.literal("assistant"),
  content: v.fallback(
    v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
    [],
  ),
  stopReason: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
});
type AssistantMessage = v.InferOutput<typeof assistantMessageSchema>;
const messageEndSchema = v.looseObject({ message: v.unknown() });
const toolExecutionStartSchema = v.looseObject({ toolName: v.string() });

/** Main-process client for `pi --mode rpc`. Every public operation owns one fresh `--no-session` child. */
export class PiRpcClient {
  private readonly processFactory: PiProcessFactory;

  constructor(
    private readonly executablePath: string,
    options: { readonly processFactory?: PiProcessFactory } = {},
  ) {
    this.processFactory =
      options.processFactory ??
      ((file, args, spawnOptions) => spawn(file, [...args], spawnOptions));
  }

  /** Lists the models the pi login can run, from a throwaway child with no tools. */
  async listModels(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<ReadonlyArray<PiCliModel>, PiRpcFailure>> {
    const opened = await this.open(["--no-tools"], undefined, options.signal);
    if (opened._tag === "err") return opened;
    const channel = opened.value;
    try {
      const response = await channel.request(
        { type: "get_available_models" },
        options.signal,
        MODEL_LIST_TIMEOUT_MS,
      );
      if (response._tag === "err")
        return err({
          reason: classifyRequestFailure(response.error),
          phase: "model_list",
        });
      const data = v.safeParse(modelListDataSchema, response.value.data);
      if (!data.success || data.output.models.length > MAX_MODELS)
        return err({ reason: "invalid_result", phase: "model_list" });
      const models = data.output.models.flatMap(insightModel);
      // `get_available_models` lists only models with configured auth, so an empty list means no login.
      return models.length === 0
        ? err({ reason: "authentication_required", phase: "model_list" })
        : ok(models);
    } finally {
      channel.stop();
    }
  }

  /** Runs one Insight prompt with pi's read-only tools and parses the final message as JSON. */
  async run(
    input: PiRpcRunInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<unknown, PiRpcFailure>> {
    if (
      Buffer.byteLength(input.prompt, "utf8") >
      (input.maxPromptBytes ?? MAX_PROMPT_BYTES)
    )
      return err({ reason: "invalid_result", phase: "prompt" });
    const opened = await this.open(
      [
        "--tools",
        PI_READ_ONLY_TOOLS.join(","),
        "--model",
        input.model,
        "--thinking",
        input.reasoning,
      ],
      input.worktreePath,
      options.signal,
    );
    if (opened._tag === "err") return opened;
    const channel = opened.value;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort("timed_out"),
      input.runTimeoutMs ?? RUN_TIMEOUT_MS,
    );
    try {
      return await runPrompt(channel, input, controller.signal);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      channel.stop();
    }
  }

  /**
   * Checks the installed version, then starts one RPC child. Extensions are
   * off because they run with full access, and `--no-approve` ignores the
   * reviewed worktree's trust-gated project-local configuration.
   */
  private async open(
    args: ReadonlyArray<string>,
    cwd: RepresentedReviewWorktree | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Result<PiRpcChannel, PiRpcFailure>> {
    if (signal?.aborted) return err({ reason: "cancelled", phase: "start" });
    const version = await this.readVersion();
    if (version._tag === "err") return version;
    const spawnOptions: SpawnOptions = {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: allowlistedPiEnvironment(),
    };
    const opened = PiRpcChannel.open(
      this.processFactory,
      this.executablePath,
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-approve",
        ...args,
      ],
      cwd === undefined ? spawnOptions : { ...spawnOptions, cwd },
    );
    return opened._tag === "ok"
      ? opened
      : err({ reason: "runtime_unavailable", phase: "start" });
  }

  private async readVersion(): Promise<Result<void, PiRpcFailure>> {
    const unavailable = err({
      reason: "runtime_unavailable" as const,
      phase: "version" as const,
    });
    let child: ChildProcess;
    try {
      child = this.processFactory(this.executablePath, ["--version"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        env: allowlistedPiEnvironment(),
      });
    } catch {
      return unavailable;
    }
    const { stdout } = child;
    if (stdout === null) {
      child.kill();
      return unavailable;
    }
    const output = await new Promise<string | undefined>((resolve) => {
      let text = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve(undefined);
      }, VERSION_TIMEOUT_MS);
      stdout.on("data", (chunk: Buffer | string) => {
        if (text.length < 1024) text += chunk.toString();
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.once("close", (code: number | null) => {
        clearTimeout(timer);
        resolve(code === 0 ? text : undefined);
      });
    });
    const match = output?.match(/(\d+)\.(\d+)\.(\d+)/u);
    if (match === null || match === undefined) return unavailable;
    const installed = [Number(match[1]), Number(match[2]), Number(match[3])];
    for (const [index, required] of MINIMUM_VERSION_PARTS.entries()) {
      const part = installed[index] ?? 0;
      if (part > required) return ok(undefined);
      if (part < required)
        return err({
          reason: "runtime_unavailable",
          phase: "version",
          requiredVersion: PI_CLI_MINIMUM_VERSION,
        });
    }
    return ok(undefined);
  }
}

/**
 * Confirms pi resolved exactly the requested model and thinking level, sends
 * the prompt, and waits for `agent_settled`. A tool outside the read-only
 * allowlist ends the run as failed.
 */
async function runPrompt(
  channel: PiRpcChannel,
  input: PiRpcRunInput,
  signal: AbortSignal,
): Promise<Result<unknown, PiRpcFailure>> {
  const state = await channel.request({ type: "get_state" }, signal);
  if (state._tag === "err")
    return err({
      reason: runFailureReason(state.error, signal),
      phase: "session_state",
    });
  const parsedState = v.safeParse(sessionStateSchema, state.value.data);
  if (
    !parsedState.success ||
    parsedState.output.model === undefined ||
    `${parsedState.output.model.provider}/${parsedState.output.model.id}` !==
      input.model ||
    parsedState.output.thinkingLevel !== input.reasoning
  )
    return err({ reason: "runtime_unavailable", phase: "session_state" });

  let lastAssistant: AssistantMessage | undefined;
  let resolveRun: (result: Result<unknown, PiRpcFailure>) => void = () =>
    undefined;
  const finished = new Promise<Result<unknown, PiRpcFailure>>((resolve) => {
    resolveRun = resolve;
  });
  const stopEvents = channel.onEvent((record) => {
    if (record.type === "message_end") {
      const end = v.safeParse(messageEndSchema, record);
      const message = end.success
        ? v.safeParse(assistantMessageSchema, end.output.message)
        : undefined;
      if (message?.success === true) lastAssistant = message.output;
      return;
    }
    if (record.type === "tool_execution_start") {
      const tool = v.safeParse(toolExecutionStartSchema, record);
      if (
        !tool.success ||
        !PI_READ_ONLY_TOOLS.some((name) => name === tool.output.toolName)
      ) {
        channel.send({ type: "abort" });
        resolveRun(err({ reason: "execution_failed", phase: "tool" }));
      }
      return;
    }
    if (record.type === "agent_settled")
      resolveRun(settledResult(lastAssistant));
  });
  const stopExit = channel.onExit(() =>
    resolveRun(err({ reason: "execution_failed", phase: "turn" })),
  );
  const onAbort = (): void => {
    channel.send({ type: "abort" });
    resolveRun(
      err({
        reason: signal.reason === "timed_out" ? "timed_out" : "cancelled",
        phase: "turn",
      }),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const accepted = await channel.request(
      { type: "prompt", message: input.prompt },
      signal,
    );
    if (accepted._tag === "err")
      return err({
        reason: runFailureReason(accepted.error, signal),
        phase: "prompt",
      });
    return await finished;
  } finally {
    signal.removeEventListener("abort", onAbort);
    stopEvents();
    stopExit();
  }
}

/** The run's outcome from the last assistant message once pi has no automatic work left. */
function settledResult(
  message: AssistantMessage | undefined,
): Result<unknown, PiRpcFailure> {
  if (message === undefined)
    return err({ reason: "execution_failed", phase: "turn" });
  if (message.stopReason === "error")
    return err({
      reason: classifyErrorMessage(message.errorMessage ?? ""),
      phase: "turn",
    });
  if (message.stopReason === "aborted")
    return err({ reason: "cancelled", phase: "turn" });
  const text = message.content
    .flatMap((block) =>
      block.type === "text" && block.text !== undefined ? [block.text] : [],
    )
    .join("");
  const parsed = parseTurnJson(text);
  return parsed._tag === "ok"
    ? parsed
    : err({ reason: "invalid_result", phase: "turn" });
}

function insightModel(
  entry: PiModelEntry | undefined,
): ReadonlyArray<PiCliModel> {
  if (entry === undefined || entry.reasoning !== true) return [];
  const { provider, id, thinkingLevelMap } = entry;
  const modelId = `${provider}/${id}`;
  if (modelId.length > MAX_MODEL_ID_CHARS) return [];
  // Mirrors pi's getSupportedThinkingLevels: a null mapping hides a level, and xhigh needs an explicit one.
  const reasoning = INSIGHT_REASONING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" || mapped !== undefined;
  });
  if (reasoning.length === 0) return [];
  const model = { id: modelId, label: modelId, reasoning };
  return [
    reasoning.includes("medium")
      ? { ...model, defaultReasoning: "medium" as const }
      : model,
  ];
}

function runFailureReason(
  failure: PiRpcRequestFailure,
  signal: AbortSignal,
): PiRpcFailure["reason"] {
  if (failure._tag === "cancelled")
    return signal.reason === "timed_out" ? "timed_out" : "cancelled";
  return classifyRequestFailure(failure);
}

function classifyRequestFailure(
  failure: PiRpcRequestFailure,
): PiRpcFailure["reason"] {
  switch (failure._tag) {
    case "cancelled":
      return "cancelled";
    case "timeout":
      return "timed_out";
    case "process_exited":
      return "execution_failed";
    case "command_failed":
      return classifyErrorMessage(failure.message);
  }
}

/** Classifies pi's own error text; a missing or expired login names `/login` or an API key. */
function classifyErrorMessage(message: string): PiRpcFailure["reason"] {
  const detail = message.toLowerCase();
  if (
    detail.includes("authentication failed") ||
    detail.includes("no api key") ||
    detail.includes("/login") ||
    detail.includes("unauthorized") ||
    /\b401\b/u.test(detail)
  )
    return "authentication_required";
  if (
    detail.includes("rate limit") ||
    detail.includes("usage limit") ||
    /\b429\b/u.test(detail)
  )
    return "rate_limited";
  if (detail.includes("timed out") || detail.includes("timeout"))
    return "timed_out";
  return "execution_failed";
}

/** The restricted environment inherited by the pi child; `PI_CODING_AGENT_DIR` locates a login kept outside `~/.pi/agent`. */
function allowlistedPiEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "PI_CODING_AGENT_DIR",
    "PI_PACKAGE_DIR",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
