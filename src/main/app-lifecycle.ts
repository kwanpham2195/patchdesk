/** Server details available after successful local API startup. */
export type StartedLocalApi = {
  readonly capability: string;
  readonly url: URL;
};

/** The safe result of starting the local API before the desktop workbench opens. */
export type LocalApiStartupResult<
  TServer extends StartedLocalApi = StartedLocalApi,
> =
  | { readonly _tag: "started"; readonly server: TServer }
  | { readonly _tag: "invalid-configuration" }
  /** Startup stops before recovery when legacy state cannot be migrated safely. */
  | { readonly _tag: "migration-failed" };

/** Narrow server lifecycle dependency owned by the desktop composition root. */
export type LocalApiLifecycle = {
  start(): Promise<LocalApiStartupResult>;
  healthCheck(server: StartedLocalApi): Promise<boolean>;
  stop(server: StartedLocalApi): Promise<void>;
};

/** Dependencies used to sequence local API startup before Electron shows the workbench. */
export type DesktopLifecycleDependencies = {
  readonly localApi: LocalApiLifecycle;
  showWorkbench(server: StartedLocalApi): Promise<void>;
};

/** Result from attempting to start the desktop workbench. */
export type DesktopStartResult =
  { readonly _tag: "started" } | { readonly _tag: "local-api-unavailable" };

/** Owns local API startup, health verification, workbench display, and shutdown ordering. */
export function createDesktopLifecycle(
  dependencies: DesktopLifecycleDependencies,
): {
  start(): Promise<DesktopStartResult>;
  stop(): Promise<void>;
} {
  let activeServer: StartedLocalApi | undefined;

  return {
    async start(): Promise<DesktopStartResult> {
      const startup = await dependencies.localApi.start();
      if (startup._tag !== "started") {
        return { _tag: "local-api-unavailable" };
      }

      const server = startup.server;
      activeServer = server;

      let isHealthy: boolean;
      try {
        isHealthy = await dependencies.localApi.healthCheck(server);
      } catch {
        await stopAfterFailedHealthCheck(server);
        return { _tag: "local-api-unavailable" };
      }

      if (!isHealthy) {
        await stopAfterFailedHealthCheck(server);
        return { _tag: "local-api-unavailable" };
      }

      try {
        await dependencies.showWorkbench(server);
      } catch (cause: unknown) {
        await dependencies.localApi.stop(server);
        activeServer = undefined;
        throw cause;
      }

      return { _tag: "started" };
    },
    async stop(): Promise<void> {
      if (activeServer === undefined) {
        return;
      }

      const server = activeServer;
      activeServer = undefined;
      await dependencies.localApi.stop(server);
    },
  };

  async function stopAfterFailedHealthCheck(
    server: StartedLocalApi,
  ): Promise<void> {
    activeServer = undefined;
    try {
      await dependencies.localApi.stop(server);
    } catch {
      // A failed health check already makes startup terminal; do not leak cleanup details into Electron.
    }
  }
}
