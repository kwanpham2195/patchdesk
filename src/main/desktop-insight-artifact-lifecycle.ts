import {
  acquireInsightArtifactWorker,
  type InsightArtifactWorker,
} from "#src/adapters/storage/insight-artifact-worker";
import type { LocalApiStartupResult } from "./app-lifecycle";
import type { LocalApiServer } from "./local-api";

type DesktopInsightArtifactLifecycle = {
  start(): Promise<LocalApiStartupResult<LocalApiServer>>;
  stop(): Promise<void>;
};

/** Couples the desktop API's consumers to one worker acquired before construction/recovery. */
export function createDesktopInsightArtifactLifecycle(
  workerEntry: URL,
  startApi: (
    reader: InsightArtifactWorker["read"],
  ) => Promise<LocalApiStartupResult<LocalApiServer>>,
): DesktopInsightArtifactLifecycle {
  let terminal = false;
  let starting: Promise<LocalApiStartupResult<LocalApiServer>> | undefined;
  let active:
    | {
        readonly worker: InsightArtifactWorker;
        readonly server: LocalApiServer;
      }
    | undefined;
  let stopping: Promise<void> | undefined;

  return {
    start() {
      if (terminal) return Promise.resolve({ _tag: "recovery-failed" });
      starting ??= startOwnedApi();
      return starting;
    },
    stop() {
      terminal = true;
      stopping ??= (async () => {
        await starting;
        const owned = active;
        active = undefined;
        if (owned === undefined) return;
        try {
          await owned.server.stop();
        } finally {
          await dispose(owned.worker);
        }
      })();
      return stopping;
    },
  };

  async function startOwnedApi(): Promise<
    LocalApiStartupResult<LocalApiServer>
  > {
    const acquired = await acquireInsightArtifactWorker(workerEntry);
    if (acquired._tag === "err") return { _tag: "recovery-failed" };
    const worker = acquired.value;
    try {
      if (terminal) return { _tag: "recovery-failed" };
      const startup = await startApi(worker.read);
      if (startup._tag !== "started") return startup;
      if (terminal) {
        await startup.server.stop();
        return { _tag: "recovery-failed" };
      }
      active = { worker, server: startup.server };
      return startup;
    } finally {
      if (active === undefined) await dispose(worker);
    }
  }
}

async function dispose(worker: InsightArtifactWorker): Promise<void> {
  const disposed = await worker.dispose();
  // The desktop lifecycle reports shutdown exceptions through its existing failure boundary.
  if (disposed._tag === "err")
    throw new Error("Insight artifact worker termination failed");
}
