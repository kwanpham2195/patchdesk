/** Server details available after successful local API startup. */
export type StartedLocalApi = {
  readonly capability: string;
  readonly url: URL;
};

/** Narrow server lifecycle dependency owned by the desktop composition root. */
export type LocalApiLifecycle = {
  start(): Promise<StartedLocalApi>;
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
      const server = await dependencies.localApi.start();
      activeServer = server;

      const isHealthy = await dependencies.localApi.healthCheck(server);
      if (!isHealthy) {
        await dependencies.localApi.stop(server);
        activeServer = undefined;
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
}
