import { app, BrowserWindow } from "electron";
import { join } from "node:path";

import { createDesktopLifecycle } from "./app-lifecycle";
import { preloadScriptPath } from "./electron-paths";
import { createAppCapability } from "./ipc-contract";
import {
  healthCheckLocalApi,
  startLocalApiServer,
  type LocalApiServer,
} from "./local-api";
import { CommandRunner } from "../adapters/github/command-runner";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { err, ok } from "../domain/result";
import { FlueCliReviewInvoker } from "../services/flue-cli-review-invoker";
import { ReviewCompletionService } from "../services/review-completion-service";

const rendererOrigin = getRendererOrigin();
let runningLocalApi: LocalApiServer | undefined;
const desktopLifecycle = createDesktopLifecycle({
  localApi: {
    async start() {
      const startup = await startLocalApiServer({
        allowedOrigin: rendererOrigin,
        // electron-vite loads this fixed local origin in development; the capability still protects the loopback API.
        developmentOrigin: "http://localhost:5173",
        capability: createAppCapability(),
        workflowInvoker: createWorkflowInvoker(),
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
        preload: preloadScriptPath(__dirname),
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

function createWorkflowInvoker() {
  const completion = new ReviewCompletionService(PatchdeskPaths.default(), () => new Date().toISOString() as never);
  const flue = new FlueCliReviewInvoker(new CommandRunner(), app.getAppPath());
  return {
    async invoke(input: Parameters<FlueCliReviewInvoker["invoke"]>[0]) {
      const result = await flue.invoke(input);
      if (result._tag === "err") return err({ reason: "failed" as const });
      const persisted = await completion.complete({ profileId: input.profileId, sessionId: input.sessionId, attemptId: input.attemptId, result: result.value });
      if (persisted._tag === "err") return err({ reason: "failed" as const });
      return ok({ runId: `flue:${input.sessionId}:${input.attemptId}` });
    },
  };
}

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
