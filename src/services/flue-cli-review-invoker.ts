import { join } from "node:path";

import type { CommandRunner } from "../adapters/github/command-runner";
import { parseModelReviewResult, type ModelReviewResult } from "../domain/review-result";
import { err, ok, type Result } from "../domain/result";
import type { ReviewWorkflowInput } from "./review-workflow-starter";

export type FlueCliReviewFailure = { readonly reason: "execution_failed" | "invalid_result" };

/** Runs the fixed finite workflow through Flue's CLI; stderr and event output remain inside this adapter. */
export class FlueCliReviewInvoker {
  constructor(
    private readonly commands: CommandRunner,
    private readonly projectRoot: string,
    private readonly runtimeExecutable = process.execPath,
    private readonly cliPath = join(projectRoot, "node_modules/@flue/cli/bin/flue.mjs"),
  ) {}

  async invoke(input: ReviewWorkflowInput): Promise<Result<ModelReviewResult, FlueCliReviewFailure>> {
    const output = await this.commands.runJson({
      argv: [this.runtimeExecutable, this.cliPath, "run", "workflow:review-pr", "--input", JSON.stringify(input)],
      cwd: this.projectRoot,
      timeoutMs: 10 * 60_000,
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    });
    if (output._tag === "err") return err({ reason: "execution_failed" });
    const parsed = parseModelReviewResult(output.value);
    return parsed._tag === "ok" ? ok(parsed.value) : err({ reason: "invalid_result" });
  }
}
