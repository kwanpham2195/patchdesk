import { join } from "node:path";

import { providerEnvironmentNames } from "../adapters/pi/pi-provider-catalog";

import type {
  CommandFailure,
  CommandRunner,
} from "../adapters/github/command-runner";
import { parseBriefOutput, type BriefOutput } from "../domain/brief";
import { definedProps } from "../domain/defined-props";
import {
  parseModelReviewResult,
  type ModelReviewResult,
} from "../domain/review-result";
import { err, ok, type Result } from "../domain/result";
import type { BriefInput } from "./brief-operation";
import {
  ANALYSIS_RUN_TIMEOUT_MS,
  BRIEF_RUN_TIMEOUT_MS,
} from "./child-invocation";
import { readObjectField } from "./read-object-field";
import {
  parseWalkthroughOutput,
  type WalkthroughInput,
  type WalkthroughOutput,
} from "./walkthrough-operation";

const MAX_CHILD_STDIN_BYTES = 2 * 1024 * 1024;
/** The child bounds its own detail; this is the app-side backstop. */
const MAX_CHILD_DETAIL_CHARS = 200;

export type FlueInsightChildFailure = {
  readonly reason:
    | "cancelled"
    | "authentication_required"
    | "rate_limited"
    | "runtime_unavailable"
    | "timed_out"
    | "execution_failed"
    | "invalid_result";
  /**
   * The child's bounded, redacted account of why the run failed, forwarded to
   * `InsightRunExecutor` so a provider refusal is recorded as a cause instead
   * of a bare category. Absent whenever the child had nothing to say.
   */
  readonly stderr?: string;
};

export type FlueInsightChildAnalysisInput = {
  readonly profileId: string;
  readonly sessionId: string;
  readonly contextPath: string;
  readonly reviewInputPath: string;
  readonly patchPath: string;
  readonly worktreePath: string;
  readonly model: string;
  readonly reasoning: "low" | "medium" | "high";
};

/** Runs a bounded app-owned one-shot child with the selected built-in provider's ambient credentials. */
export class FlueInsightChildInvoker {
  constructor(
    private readonly commands: CommandRunner,
    private readonly projectRoot: string,
    private readonly runtimeExecutable = process.execPath,
    private readonly runnerPath = join(
      projectRoot,
      "runtime",
      "flue",
      "dist",
      "patchdesk-insight-runner.js",
    ),
  ) {}

  async invokeAnalysis(
    input: FlueInsightChildAnalysisInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<ModelReviewResult, FlueInsightChildFailure>> {
    const result = await this.invoke(
      { type: "analysis", input },
      ANALYSIS_RUN_TIMEOUT_MS,
      options?.signal,
    );
    if (result._tag === "err") return result;
    const parsed = parseModelReviewResult(result.value);
    return parsed._tag === "ok"
      ? ok(parsed.value)
      : err({ reason: "invalid_result" });
  }

  /**
   * Runs one Brief child. A runtime built before the `brief` request type
   * existed rejects the request as `invalid_input`, which is reported as a run
   * failure: the request was wrong, not the model's answer.
   */
  async invokeBrief(
    input: BriefInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<BriefOutput, FlueInsightChildFailure>> {
    const result = await this.invoke(
      { type: "brief", input },
      BRIEF_RUN_TIMEOUT_MS,
      options?.signal,
    );
    if (result._tag === "err") return result;
    const parsed = parseBriefOutput(result.value);
    return parsed._tag === "ok"
      ? ok(parsed.value)
      : err({ reason: "invalid_result" });
  }

  async invokeWalkthrough(
    input: WalkthroughInput,
    timeoutMs: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<WalkthroughOutput, FlueInsightChildFailure>> {
    const result = await this.invoke(
      { type: "walkthrough", input },
      timeoutMs,
      options?.signal,
    );
    if (result._tag === "err") return result;
    const parsed = parseWalkthroughOutput(result.value);
    return parsed._tag === "ok"
      ? ok(parsed.value)
      : err({ reason: "invalid_result" });
  }

  private async invoke(
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result<unknown, FlueInsightChildFailure>> {
    if (signal?.aborted) return err({ reason: "cancelled" });
    const stdin = JSON.stringify(body);
    if (Buffer.byteLength(stdin, "utf8") > MAX_CHILD_STDIN_BYTES)
      return err({ reason: "execution_failed" });
    const environment = productionChildEnvironment(body);
    if (environment === undefined)
      return err({ reason: "runtime_unavailable" });
    const output = await this.commands.runJson({
      argv: [this.runtimeExecutable, this.runnerPath],
      cwd: this.projectRoot,
      stdin,
      timeoutMs,
      environment,
      inheritEnvironment: false,
      ...definedProps({ signal }),
    });
    if (signal?.aborted) return err({ reason: "cancelled" });
    if (output._tag === "err")
      return err({ reason: childFailureReason(output.error) });
    const response = parseChildResponse(output.value);
    if (response === undefined) return err({ reason: "invalid_result" });
    if (response.ok) return ok(response.value);
    const reason = childResponseReason(response.reason);
    return err(
      response.detail === undefined
        ? { reason }
        : { reason, stderr: response.detail },
    );
  }
}

/**
 * Only the child's own `invalid_result` means the model answered with
 * something this app cannot read. Every other refusal -- a rejected request, a
 * provider that failed the run -- is a run failure, and reporting
 * `invalid_input` as an invalid result blamed the model for a request the app
 * or a stale staged runtime got wrong.
 */
function childResponseReason(
  reason: string,
): FlueInsightChildFailure["reason"] {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "invalid_result":
      return "invalid_result";
    default:
      return "execution_failed";
  }
}

function productionChildEnvironment(
  body: unknown,
): Readonly<Record<string, string>> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return undefined;
  const input = readObjectField(body, "input");
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const model = readObjectField(input, "model");
  if (typeof model !== "string") return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = model.slice(0, separator).toLowerCase();
  const names = providerEnvironmentNames(provider);
  if (names.length === 0) return undefined;
  const environment: Record<string, string> = {};
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  environment.LANG = "C";
  environment.LC_ALL = "C";
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const home = process.env.HOME;
  if (
    home !== undefined &&
    (provider === "amazon-bedrock" || provider === "google-vertex")
  )
    environment.HOME = home;
  return environment;
}

function parseChildResponse(input: unknown):
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly detail?: string;
    }
  | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const keys = Object.keys(input);
  const ok = readObjectField(input, "ok");
  if (ok === true && keys.length === 2 && Object.hasOwn(input, "value"))
    return { ok: true, value: readObjectField(input, "value") };
  const reason = readObjectField(input, "reason");
  if (ok === false && typeof reason === "string" && keys.length <= 3) {
    const detail = readObjectField(input, "detail");
    return keys.length === 2
      ? { ok: false, reason }
      : typeof detail === "string"
        ? { ok: false, reason, detail: detail.slice(0, MAX_CHILD_DETAIL_CHARS) }
        : undefined;
  }
  return undefined;
}

function childFailureReason(
  failure: CommandFailure,
): FlueInsightChildFailure["reason"] {
  switch (failure._tag) {
    case "CommandAuthenticationRequired":
      return "authentication_required";
    case "CommandRateLimited":
      return "rate_limited";
    case "CommandNotFound":
    case "CommandRuntimeUnavailable":
    case "CommandUnavailable":
      return "runtime_unavailable";
    case "CommandTimedOut":
      return "timed_out";
    default:
      return "execution_failed";
  }
}
