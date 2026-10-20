import {
  acquireInsightResourceBundle,
  type InsightResourceBundle,
} from "#src/services/insight-resource-bundle";
import type { LocalApiStartupResult } from "./app-lifecycle";
import type { LocalApiServer } from "./local-api";

type DesktopInsightArtifactLifecycle = {
  start(): Promise<LocalApiStartupResult<LocalApiServer>>;
  stop(): Promise<void>;
};

/** Couples the desktop API's consumers to one resource bundle (reader and job workers) acquired before construction/recovery. */
export function createDesktopInsightArtifactLifecycle(
  workerDirectory: URL,
  startApi: (
    resources: InsightResourceBundle,
  ) => Promise<LocalApiStartupResult<LocalApiServer>>,
): DesktopInsightArtifactLifecycle {
  let terminal = false;
  let starting: Promise<LocalApiStartupResult<LocalApiServer>> | undefined;
  let active:
    | {
        readonly resources: InsightResourceBundle;
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
          await dispose(owned.resources);
        }
      })();
      return stopping;
    },
  };

  async function startOwnedApi(): Promise<
    LocalApiStartupResult<LocalApiServer>
  > {
    const acquired = await acquireInsightResourceBundle(
      new URL("insight-artifact-worker.js", workerDirectory),
      new URL("insight-artifact-job.js", workerDirectory),
    );
    if (acquired._tag === "err") return { _tag: "recovery-failed" };
    const resources = acquired.value;
    try {
      if (terminal) return { _tag: "recovery-failed" };
      const startup = await startApi(resources);
      if (startup._tag !== "started") return startup;
      if (terminal) {
        await startup.server.stop();
        return { _tag: "recovery-failed" };
      }
      active = { resources, server: startup.server };
      return startup;
    } finally {
      if (active === undefined) await dispose(resources);
    }
  }
}

async function dispose(resources: InsightResourceBundle): Promise<void> {
  const disposed = await resources.dispose();
  // The desktop lifecycle reports shutdown exceptions through its existing failure boundary.
  if (disposed._tag === "err")
    throw new Error("Insight artifact worker termination failed");
}
