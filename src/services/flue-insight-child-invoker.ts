import { join } from "node:path";

import type { CommandFailure, CommandRunner } from "../adapters/github/command-runner";
import { parseModelReviewResult, type ModelReviewResult } from "../domain/review-result";
import { err, ok, type Result } from "../domain/result";
import { parseWalkthroughOutput, type WalkthroughInput, type WalkthroughOutput } from "./walkthrough-operation";

const MAX_CHILD_STDIN_BYTES = 2 * 1024 * 1024;

export type FlueInsightChildFailure = {
  readonly reason: "cancelled" | "authentication_required" | "rate_limited" | "runtime_unavailable" | "timed_out" | "execution_failed" | "invalid_result";
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

/** Runs a bounded one-shot child with no inherited parent environment. */
export class FlueInsightChildInvoker {
  constructor(
    private readonly commands: CommandRunner,
    private readonly projectRoot: string,
    private readonly runtimeExecutable = process.execPath,
    private readonly runnerPath = join(projectRoot, "runtime", "flue", "dist", "patchdesk-insight-runner.js"),
  ) {}

  async invokeAnalysis(input: FlueInsightChildAnalysisInput, options?: { readonly signal?: AbortSignal }): Promise<Result<ModelReviewResult, FlueInsightChildFailure>> {
    const result = await this.invoke({ type: "analysis", input }, 10 * 60_000, options?.signal);
    if (result._tag === "err") return result;
    const parsed = parseModelReviewResult(result.value);
    return parsed._tag === "ok" ? ok(parsed.value) : err({ reason: "invalid_result" });
  }

  async invokeWalkthrough(input: WalkthroughInput, timeoutMs: number, options?: { readonly signal?: AbortSignal }): Promise<Result<WalkthroughOutput, FlueInsightChildFailure>> {
    const result = await this.invoke({ type: "walkthrough", input }, timeoutMs, options?.signal);
    if (result._tag === "err") return result;
    const parsed = parseWalkthroughOutput(result.value);
    return parsed._tag === "ok" ? ok(parsed.value) : err({ reason: "invalid_result" });
  }

  private async invoke(body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Result<unknown, FlueInsightChildFailure>> {
    if (signal?.aborted) return err({ reason: "cancelled" });
    const stdin = JSON.stringify(body);
    if (Buffer.byteLength(stdin, "utf8") > MAX_CHILD_STDIN_BYTES)
      return err({ reason: "execution_failed" });
    const output = await this.commands.runJson({
      argv: [this.runtimeExecutable, this.runnerPath],
      cwd: this.projectRoot,
      stdin,
      timeoutMs,
      // This isolated adapter does not inherit parent credentials. Step 8
      // supplies the selected provider's explicit environment contract.
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      inheritEnvironment: false,
      ...(signal === undefined ? {} : { signal }),
    });
    if (signal?.aborted) return err({ reason: "cancelled" });
    if (output._tag === "err") return err({ reason: childFailureReason(output.error) });
    const response = parseChildResponse(output.value);
    if (response === undefined) return err({ reason: "invalid_result" });
    if (response.ok) return ok(response.value);
    return err({
      reason:
        response.reason === "cancelled"
          ? "cancelled"
          : response.reason === "runtime_unavailable"
            ? "runtime_unavailable"
            : response.reason === "invalid_result" || response.reason === "invalid_input"
              ? "invalid_result"
              : "execution_failed",
    });
  }
}

function parseChildResponse(
  input: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string }
  | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (record.ok === true && keys.length === 2 && Object.hasOwn(record, "value"))
    return { ok: true, value: record.value };
  if (
    record.ok === false &&
    keys.length === 2 &&
    typeof record.reason === "string"
  )
    return { ok: false, reason: record.reason };
  return undefined;
}

function childFailureReason(failure: CommandFailure): FlueInsightChildFailure["reason"] {
  switch (failure._tag) {
    case "CommandAuthenticationRequired": return "authentication_required";
    case "CommandRateLimited": return "rate_limited";
    case "CommandNotFound":
    case "CommandRuntimeUnavailable":
    case "CommandUnavailable": return "runtime_unavailable";
    case "CommandTimedOut": return "timed_out";
    default: return "execution_failed";
  }
}
