import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CommandFailure, CommandRunner } from "../adapters/github/command-runner";
import { err, ok, type Result } from "../domain/result";
import {
  parseWalkthroughOutput,
  type WalkthroughInput,
  type WalkthroughOutput,
} from "../workflows/generate-walkthrough";

export type FlueCliWalkthroughInput = WalkthroughInput;

const WALKTHROUGH_MIN_TIMEOUT_MS = 120_000;
const WALKTHROUGH_TIMEOUT_STEP_MS = 30_000;
const WALKTHROUGH_MAX_TIMEOUT_MS = 600_000;
const WALKTHROUGH_BYTES_PER_STEP = 256 * 1024;
const WALKTHROUGH_HUNKS_PER_STEP = 8;

type WalkthroughArtifactSizes = {
  readonly patchBytes: number;
  readonly contextBytes: number;
  readonly hunkCount: number;
};

type WalkthroughArtifactSizeReader = (
  input: WalkthroughInput,
) => Promise<WalkthroughArtifactSizes>;

/** Calculates a bounded timeout from the supplied artifact size and hunk count. */
export function walkthroughTimeoutMs(sizes: WalkthroughArtifactSizes): number {
  const patchBytes = Number.isFinite(sizes.patchBytes) ? Math.max(0, sizes.patchBytes) : 0;
  const contextBytes = Number.isFinite(sizes.contextBytes) ? Math.max(0, sizes.contextBytes) : 0;
  const hunkCount = Number.isFinite(sizes.hunkCount) ? Math.max(0, sizes.hunkCount) : 0;
  const sizeSteps = Math.ceil((patchBytes + contextBytes) / WALKTHROUGH_BYTES_PER_STEP);
  const hunkSteps = Math.ceil(hunkCount / WALKTHROUGH_HUNKS_PER_STEP);
  return Math.min(
    WALKTHROUGH_MAX_TIMEOUT_MS,
    WALKTHROUGH_MIN_TIMEOUT_MS + Math.max(sizeSteps, hunkSteps) * WALKTHROUGH_TIMEOUT_STEP_MS,
  );
}

/** Safe classifications for the isolated walkthrough process boundary. */
export type FlueCliWalkthroughFailure =
  | { readonly reason: "authentication_required" | "rate_limited" | "runtime_unavailable" | "timed_out" | "execution_failed" }
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
    private readonly artifactSizeReader: WalkthroughArtifactSizeReader = readWalkthroughArtifactSizes,
  ) {}

  /** Invoke one caller-owned, cancellable walkthrough generation process. */
  async invoke(
    input: WalkthroughInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<WalkthroughOutput, FlueCliWalkthroughFailure>> {
    if (options?.signal?.aborted) return err({ reason: "cancelled" });

    let sizes: WalkthroughArtifactSizes;
    try {
      sizes = await this.artifactSizeReader(input);
    } catch {
      sizes = { patchBytes: 0, contextBytes: 0, hunkCount: 0 };
    }

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
      timeoutMs: walkthroughTimeoutMs(sizes),
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (options?.signal?.aborted) return err({ reason: "cancelled" });
    if (output._tag === "err") return err({ reason: walkthroughFailureReason(output.error) });

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

function walkthroughFailureReason(failure: CommandFailure): FlueCliWalkthroughFailure["reason"] {
  switch (failure._tag) {
    case "CommandAuthenticationRequired": return "authentication_required";
    case "CommandRateLimited": return "rate_limited";
    case "CommandNotFound":
    case "CommandRuntimeUnavailable":
    case "CommandUnavailable": return "runtime_unavailable";
    case "CommandTimedOut": return "timed_out";
    case "CommandFailed":
    case "CommandInvalidJson": return "execution_failed";
  }
}

async function readWalkthroughArtifactSizes(
  input: WalkthroughInput,
): Promise<WalkthroughArtifactSizes> {
  const [patch, context] = await Promise.all([
    stat(input.patchPath),
    stat(input.contextPath),
  ]);
  return {
    patchBytes: patch.size,
    contextBytes: context.size,
    hunkCount: 0,
  };
}
