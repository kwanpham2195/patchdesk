import { createReadStream } from "node:fs";
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

const WALKTHROUGH_MIN_TIMEOUT_MS = 5 * 60_000;
const WALKTHROUGH_TIMEOUT_STEP_MS = 60_000;
const WALKTHROUGH_MAX_TIMEOUT_MS = 20 * 60_000;
const WALKTHROUGH_BYTES_PER_STEP = 256 * 1024;
const WALKTHROUGH_HUNKS_PER_STEP = 8;
// Once this many hunks are found, additional hunks cannot increase the bounded timeout.
const WALKTHROUGH_HUNK_COUNT_CAP = 113;

type WalkthroughArtifactSizes = {
  readonly patchBytes: number;
  readonly contextBytes: number;
  readonly hunkCount: number;
};

type WalkthroughArtifactSizeReader = (
  input: WalkthroughInput,
  signal?: AbortSignal,
) => Promise<WalkthroughArtifactSizes>;

/** Calculates a bounded timeout: five minutes minimum, one minute per size/hunk step, capped at twenty minutes. */
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
  | { readonly reason: "authentication_required" | "rate_limited" | "runtime_unavailable" | "timed_out" | "execution_failed"; readonly stderr?: string }
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
      sizes = await this.artifactSizeReader(input, options?.signal);
    } catch {
      // Cancellation is not a read failure and must not fall back to running Flue.
      if (options?.signal?.aborted) return err({ reason: "cancelled" });
      sizes = { patchBytes: 0, contextBytes: 0, hunkCount: 0 };
    }
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
      timeoutMs: walkthroughTimeoutMs(sizes),
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    if (options?.signal?.aborted) return err({ reason: "cancelled" });
    if (output._tag === "err") return err(stderrFailure(output.error));

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
    case "CommandForbidden":
    case "CommandUnsupported":
    case "CommandInvalidJson": return "execution_failed";
  }
}

function stderrFailure(failure: CommandFailure): FlueCliWalkthroughFailure {
  const reason = walkthroughFailureReason(failure);
  if (failure._tag === "CommandFailed" && failure.stderr !== undefined) {
    return { reason, stderr: failure.stderr };
  }
  return { reason };
}

async function readWalkthroughArtifactSizes(
  input: WalkthroughInput,
  signal?: AbortSignal,
): Promise<WalkthroughArtifactSizes> {
  const [patch, context] = await Promise.all([
    stat(input.patchPath),
    stat(input.contextPath),
  ]);
  return {
    patchBytes: patch.size,
    contextBytes: context.size,
    hunkCount: await countUnifiedDiffHunks(input.patchPath, signal),
  };
}

/** Count unified-diff hunk markers without retaining the patch in memory. */
function countUnifiedDiffHunks(patchPath: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve(0);
      return;
    }

    const stream = createReadStream(patchPath);
    let count = 0;
    let lineStart = true;
    let markerPrefixLength = 0;
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      if (settled) return;
      stream.destroy();
      finish(0);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const byte of bytes) {
        if (byte === 0x0a) {
          lineStart = true;
          markerPrefixLength = 0;
          continue;
        }
        if (!lineStart) continue;
        if (markerPrefixLength === 0 && byte === 0x40) {
          markerPrefixLength = 1;
          continue;
        }
        if (markerPrefixLength === 1 && byte === 0x40) {
          markerPrefixLength = 2;
          continue;
        }
        if (markerPrefixLength === 2 && byte === 0x20) {
          count += 1;
          if (count >= WALKTHROUGH_HUNK_COUNT_CAP) {
            stream.destroy();
            finish(WALKTHROUGH_HUNK_COUNT_CAP);
            return;
          }
        }
        lineStart = false;
        markerPrefixLength = 0;
      }
    });
    stream.once("end", () => finish(count));
    stream.once("error", fail);
  });
}
