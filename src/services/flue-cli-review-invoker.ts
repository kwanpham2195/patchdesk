import { join } from "node:path";

import type { CommandFailure, CommandRunner } from "../adapters/github/command-runner";
import { parseModelReviewResult, type ModelReviewResult } from "../domain/review-result";
import { err, ok, type Result } from "../domain/result";
import type { ReviewWorkflowInput } from "./review-workflow-starter";
import type { ReviewActivityStep } from "./run-projection";

export type FlueCliReviewFailure = {
  readonly reason:
    | "cancelled"
    | "authentication_required"
    | "rate_limited"
    | "runtime_unavailable"
    | "timed_out"
    | "execution_failed"
    | "invalid_result";
};

/** Runs the fixed finite workflow through Flue's CLI; stderr and event output remain inside this adapter. */
export class FlueCliReviewInvoker {
  constructor(
    private readonly commands: CommandRunner,
    private readonly projectRoot: string,
    private readonly runtimeExecutable = process.execPath,
    private readonly cliPath = join(projectRoot, "node_modules/@flue/cli/bin/flue.mjs"),
  ) {}

  async invoke(
    input: ReviewWorkflowInput,
    options?: { readonly signal?: AbortSignal; readonly onActivity?: (step: Exclude<ReviewActivityStep, "complete" | "failed">) => void },
  ): Promise<Result<ModelReviewResult, FlueCliReviewFailure>> {
    if (options?.signal?.aborted) return err({ reason: "cancelled" });
    options?.onActivity?.("inspecting");
    const output = await this.commands.runJson({
      argv: [this.runtimeExecutable, this.cliPath, "run", "workflow:review-pr", "--input", JSON.stringify(input)],
      cwd: this.projectRoot,
      timeoutMs: 10 * 60_000,
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options?.signal?.aborted) return err({ reason: "cancelled" });
    if (output._tag === "err") return err({ reason: reviewFailureReason(output.error) });
    options?.onActivity?.("validating");
    const parsed = parseModelReviewResult(output.value);
    return parsed._tag === "ok" ? ok(parsed.value) : err({ reason: "invalid_result" });
  }
}

function reviewFailureReason(failure: CommandFailure): FlueCliReviewFailure["reason"] {
  switch (failure._tag) {
    case "CommandAuthenticationRequired": return "authentication_required";
    case "CommandRateLimited": return "rate_limited";
    case "CommandRuntimeUnavailable":
    case "CommandUnavailable": return "runtime_unavailable";
    case "CommandTimedOut": return "timed_out";
    case "CommandFailed":
    case "CommandInvalidJson": return "execution_failed";
  }
}
