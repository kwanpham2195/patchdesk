import { app, BrowserWindow } from "electron";
import { join } from "node:path";

import { createDesktopLifecycle } from "./app-lifecycle";
import { createAppCapability } from "./ipc-contract";
import {
  healthCheckLocalApi,
  startLocalApiServer,
  type LocalApiServer,
} from "./local-api";

const rendererOrigin = getRendererOrigin();
let runningLocalApi: LocalApiServer | undefined;
const desktopLifecycle = createDesktopLifecycle({
  localApi: {
    async start() {
      const startup = await startLocalApiServer({
        allowedOrigin: rendererOrigin,
        capability: createAppCapability(),
      });
      if (startup._tag === "started") {
        runningLocalApi = startup.server;
      }

      return startup;
    },
    async healthCheck(server) {
      return await healthCheckLocalApi(server, rendererOrigin);
    },
    async stop() {
      if (runningLocalApi === undefined) {
        return;
      }

      const server = runningLocalApi;
      runningLocalApi = undefined;
      await server.stop();
    },
  },
  async showWorkbench(server) {
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        additionalArguments: [
          `--patchdesk-api-url=${server.url.toString()}`,
          `--patchdesk-api-capability=${server.capability}`,
        ],
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, "preload.js"),
      },
    });

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl === undefined) {
      await window.loadFile(join(__dirname, "../renderer/index.html"));
      return;
    }

    await window.loadURL(rendererUrl);
  },
});

app.whenReady().then(async () => {
  const result = await desktopLifecycle.start();
  if (result._tag === "local-api-unavailable") {
    app.exit(1);
  }
});

app.on("before-quit", (event) => {
  event.preventDefault();
  terminateAfterServerStops();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    terminateAfterServerStops();
  });
}

function getRendererOrigin(): string {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  return rendererUrl === undefined ? "null" : new URL(rendererUrl).origin;
}

function terminateAfterServerStops(): void {
  void desktopLifecycle
    .stop()
    .catch(() => undefined)
    .finally(() => {
      app.exit();
    });
}
