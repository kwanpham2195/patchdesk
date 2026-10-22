import {
  readWalkthroughArtifactSizes,
  walkthroughTimeoutMs,
} from "./walkthrough-timeout";

/** Every provider shares one total Analysis budget; continuation spends only its remaining time. */
export const ANALYSIS_RUN_TIMEOUT_MS = 20 * 60_000;

/**
 * How long a one-shot Insight child may run a Brief, for every provider.
 *
 * A Brief is two to four cited sentences over the same bounded artifacts an
 * Analysis reads, so it is bounded well below the Analysis timeout on purpose:
 * a Brief that has not answered in four minutes is not going to be the short
 * orientation the maintainer asked for.
 */
export const BRIEF_RUN_TIMEOUT_MS = 4 * 60_000;

/**
 * How long a one-shot Insight child may run a walkthrough: the patch-scaled
 * bound `walkthroughTimeoutMs` calculates, with the artifact read that feeds
 * it made non-fatal.
 *
 * Measuring the artifacts is an optimization, never a reason to fail a run —
 * an unreadable patch or context falls back to zero sizes, which yields the
 * five-minute floor. `signal` is forwarded to the hunk count so cancelling a
 * run also stops the streaming read of the patch; omitting it leaves that
 * read running to its own hunk cap after the run is already abandoned.
 */
export async function resolveWalkthroughTimeoutMs(
  input: { readonly contextPath: string; readonly patchPath: string },
  signal?: AbortSignal,
): Promise<number> {
  return walkthroughTimeoutMs(
    await readWalkthroughArtifactSizes(input, signal).catch(() => ({
      patchBytes: 0,
      contextBytes: 0,
      hunkCount: 0,
    })),
  );
}
