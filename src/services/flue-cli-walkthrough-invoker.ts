import { join } from "node:path";

import type { CommandRunner } from "../adapters/github/command-runner";
import { err, ok, type Result } from "../domain/result";
import {
  parseWalkthroughOutput,
  type WalkthroughInput,
  type WalkthroughOutput,
} from "../workflows/generate-walkthrough";

export type FlueCliWalkthroughInput = WalkthroughInput;

const WALKTHROUGH_TIMEOUT_MS = 10 * 60_000;

/** Safe classifications for the isolated walkthrough process boundary. */
export type FlueCliWalkthroughFailure =
  | { readonly reason: "execution_failed" }
  | { readonly reason: "cancelled" }
  | { readonly reason: "invalid_result" };

/**
 * Runs only `workflow:generate-walkthrough`; review persistence and review
 * completion/failure services are deliberately outside this adapter's graph.
 */
export class FlueCliWalkthroughInvoker {
  constructor(
    private readonly commands: CommandRunner,
    private readonly projectRoot: string,
    private readonly runtimeExecutable = process.execPath,
    private readonly cliPath = join(projectRoot, "node_modules/@flue/cli/bin/flue.mjs"),
  ) {}

  /** Invoke one caller-owned, cancellable walkthrough generation process. */
  async invoke(
    input: WalkthroughInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<WalkthroughOutput, FlueCliWalkthroughFailure>> {
    if (options?.signal?.aborted) return err({ reason: "cancelled" });

    const output = await this.commands.runText({
      argv: [
        this.runtimeExecutable,
        this.cliPath,
        "run",
        "workflow:generate-walkthrough",
        "--input",
        JSON.stringify(input),
      ],
      cwd: this.projectRoot,
      timeoutMs: WALKTHROUGH_TIMEOUT_MS,
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (options?.signal?.aborted) return err({ reason: "cancelled" });
    if (output._tag === "err") return err({ reason: "execution_failed" });

    let terminalJson: unknown;
    try {
      terminalJson = JSON.parse(output.value) as unknown;
    } catch {
      return err({ reason: "invalid_result" });
    }
    const parsed = parseWalkthroughOutput(terminalJson);
    return parsed._tag === "ok" ? ok(parsed.value) : err({ reason: "invalid_result" });
  }
}
