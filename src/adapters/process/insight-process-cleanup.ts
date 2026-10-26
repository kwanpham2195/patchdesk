import type { ChildProcess } from "node:child_process";
import * as v from "valibot";

export type InsightProcessCleanupFailureCause =
  | "stdin_end_threw"
  | "child_signal_threw"
  | "group_sigterm_threw"
  | "group_sigkill_threw"
  | "group_probe_threw"
  | "group_still_present"
  | "unknown";

export type InsightProcessCleanupErrorCode = "permission_denied" | "other";

export class InsightProcessCleanupError extends Error {
  constructor(
    readonly cleanupCause: InsightProcessCleanupFailureCause = "unknown",
    readonly cleanupErrorCode?: InsightProcessCleanupErrorCode,
  ) {
    super("insight_process_cleanup_failed");
  }
}

/** Only detached children created for this Insight own the group identified by their PID. */
export async function stopInsightProcess(
  child: ChildProcess,
  ownsGroup: boolean,
  onFailure?: (cause: InsightProcessCleanupFailureCause) => void,
): Promise<void> {
  try {
    child.stdin?.end();
  } catch (cause) {
    onFailure?.("stdin_end_threw");
    throw cause;
  }
  if (!ownsGroup || child.pid === undefined) {
    try {
      child.kill();
    } catch (cause) {
      onFailure?.("child_signal_threw");
      throw cause;
    }
    return;
  }
  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (cause) {
      if (v.is(v.looseObject({ code: v.literal("ESRCH") }), cause))
        return false;
      // macOS can report EPERM while an exiting group is still being reaped; only ESRCH confirms cessation.
      if (
        signal === 0 &&
        process.platform === "darwin" &&
        v.is(v.looseObject({ code: v.literal("EPERM") }), cause)
      )
        return true;
      throw new InsightProcessCleanupError(
        signal === 0
          ? "group_probe_threw"
          : signal === "SIGTERM"
            ? "group_sigterm_threw"
            : "group_sigkill_threw",
        v.is(v.looseObject({ code: v.picklist(["EPERM", "EACCES"]) }), cause)
          ? "permission_denied"
          : "other",
      );
    }
  };
  // A leader's exit does not prove its native command descendants have stopped.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!signalGroup(signal)) return;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (!signalGroup(0)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  if (signalGroup(0))
    throw new InsightProcessCleanupError("group_still_present");
}
