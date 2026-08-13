import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { WalkthroughInput } from "./walkthrough-operation";

const WALKTHROUGH_MIN_TIMEOUT_MS = 5 * 60_000;
const WALKTHROUGH_TIMEOUT_STEP_MS = 60_000;
const WALKTHROUGH_MAX_TIMEOUT_MS = 20 * 60_000;
const WALKTHROUGH_BYTES_PER_STEP = 256 * 1024;
const WALKTHROUGH_HUNKS_PER_STEP = 8;
const WALKTHROUGH_HUNK_COUNT_CAP = 113;

export type WalkthroughArtifactSizes = {
  readonly patchBytes: number;
  readonly contextBytes: number;
  readonly hunkCount: number;
};

/** Calculates a bounded timeout: five minutes minimum and twenty minutes maximum. */
export function walkthroughTimeoutMs(sizes: WalkthroughArtifactSizes): number {
  const patchBytes = Number.isFinite(sizes.patchBytes) ? Math.max(0, sizes.patchBytes) : 0;
  const contextBytes = Number.isFinite(sizes.contextBytes) ? Math.max(0, sizes.contextBytes) : 0;
  const hunkCount = Number.isFinite(sizes.hunkCount) ? Math.max(0, sizes.hunkCount) : 0;
  const sizeSteps = Math.ceil((patchBytes + contextBytes) / WALKTHROUGH_BYTES_PER_STEP);
  const hunkSteps = Math.ceil(hunkCount / WALKTHROUGH_HUNKS_PER_STEP);
  return Math.min(WALKTHROUGH_MAX_TIMEOUT_MS, WALKTHROUGH_MIN_TIMEOUT_MS + Math.max(sizeSteps, hunkSteps) * WALKTHROUGH_TIMEOUT_STEP_MS);
}

/** Reads bounded artifacts only to calculate the caller-owned child timeout. */
export async function readWalkthroughArtifactSizes(
  input: WalkthroughInput,
  signal?: AbortSignal,
): Promise<WalkthroughArtifactSizes> {
  const [patch, context] = await Promise.all([stat(input.patchPath), stat(input.contextPath)]);
  return { patchBytes: patch.size, contextBytes: context.size, hunkCount: await countUnifiedDiffHunks(input.patchPath, signal) };
}

function countUnifiedDiffHunks(patchPath: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve(0); return; }
    const stream = createReadStream(patchPath);
    let count = 0;
    let lineStart = true;
    let markerPrefixLength = 0;
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const finish = (result: number): void => { if (settled) return; settled = true; cleanup(); resolve(result); };
    const fail = (error: Error): void => { if (settled) return; settled = true; cleanup(); reject(error); };
    const onAbort = (): void => { if (!settled) { stream.destroy(); finish(0); } };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk: string | Buffer) => {
      for (const byte of (typeof chunk === "string" ? Buffer.from(chunk) : chunk)) {
        if (byte === 0x0a) { lineStart = true; markerPrefixLength = 0; continue; }
        if (!lineStart) continue;
        if (markerPrefixLength === 0 && byte === 0x40) { markerPrefixLength = 1; continue; }
        if (markerPrefixLength === 1 && byte === 0x40) { markerPrefixLength = 2; continue; }
        if (markerPrefixLength === 2 && byte === 0x20) {
          count += 1;
          if (count >= WALKTHROUGH_HUNK_COUNT_CAP) { stream.destroy(); finish(WALKTHROUGH_HUNK_COUNT_CAP); return; }
        }
        lineStart = false;
        markerPrefixLength = 0;
      }
    });
    stream.once("end", () => finish(count));
    stream.once("error", fail);
  });
}
