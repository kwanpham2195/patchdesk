import type { ChildProcess } from "node:child_process";
import * as v from "valibot";

export class InsightProcessCleanupError extends Error {
  constructor() {
    super("insight_process_cleanup_failed");
  }
}

/** Only detached children created for this Insight own the group identified by their PID. */
export async function stopInsightProcess(
  child: ChildProcess,
  ownsGroup: boolean,
): Promise<void> {
  child.stdin?.end();
  if (!ownsGroup || child.pid === undefined) {
    child.kill();
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
      throw new InsightProcessCleanupError();
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
  if (signalGroup(0)) throw new InsightProcessCleanupError();
}
