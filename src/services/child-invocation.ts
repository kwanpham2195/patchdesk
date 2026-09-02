import type { WalkthroughInput } from "./walkthrough-operation";
import {
  readWalkthroughArtifactSizes,
  walkthroughTimeoutMs,
} from "./walkthrough-timeout";

/**
 * How long a one-shot Insight child may run an Analysis, for every provider.
 *
 * Analysis reads a whole prepared bundle whose size the caller has already
 * bounded, so the bound is flat rather than scaled the way the walkthrough's
 * is. Both `PiInsightChildInvoker` and
 * `CodexInsightInvoker` spend it, and it is one constant so the two cannot
 * drift: before this it was a named constant on the Codex side and a bare
 * `10 * 60_000` on the insight-runtime side, kept in step only by a comment.
 */
export const ANALYSIS_RUN_TIMEOUT_MS = 10 * 60_000;

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

/** The one method of a walkthrough child this module spends, named as a port
 * so the wiring below can be driven without a child process. */
export type WalkthroughChildInvoker<TResult> = {
  invokeWalkthrough(
    input: WalkthroughInput,
    timeoutMs: number,
    options: { readonly signal: AbortSignal },
  ): Promise<TResult>;
};

/**
 * Runs a walkthrough child under its patch-scaled bound, resolving that bound
 * under the run's own signal.
 *
 * The two steps live in one function because separating them is what went
 * wrong: the composition root resolved the bound and called the child in a
 * single expression, and forgetting the signal there compiled (the parameter
 * is optional), returned the same bound, and broke no test — while leaving the
 * streaming patch read running for seconds after the run had been cancelled.
 * Here the signal cannot be dropped without a test noticing.
 */
export async function invokeWalkthroughWithResolvedTimeout<TResult>(
  invoker: WalkthroughChildInvoker<TResult>,
  input: WalkthroughInput,
  options: { readonly signal: AbortSignal },
): Promise<TResult> {
  return invoker.invokeWalkthrough(
    input,
    await resolveWalkthroughTimeoutMs(input, options.signal),
    options,
  );
}
