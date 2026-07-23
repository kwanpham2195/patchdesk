import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  shell,
} from "electron";
import { join } from "node:path";

import { createDesktopLifecycle, type StartedLocalApi } from "./app-lifecycle";
import { createDesktopMenuTemplate } from "./desktop-menu";
import { installDesktopRequestBridge } from "./desktop-bridge";
import {
  resolveDesktopClose,
  type DesktopNavigationState,
} from "./desktop-close-guard";
import { preloadScriptPath } from "./electron-paths";
import {
  installWebContentsSecurity,
  normalizeExternalHosts,
} from "./external-navigation";
import { createAppCapability } from "./app-capability";
import { DESKTOP_NAVIGATE_CHANNEL } from "./ipc-contract";
import {
  healthCheckLocalApi,
  startLocalApiServer,
  type LocalApiServer,
} from "./local-api";
import { CommandRunner } from "../adapters/github/command-runner";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import { err, ok } from "../domain/result";
import { FlueCliReviewInvoker } from "../services/flue-cli-review-invoker";
import { resolveWorkflowRuntimeRoot } from "./workflow-runtime-root";
import { ReviewCompletionService } from "../services/review-completion-service";
import { loadWindowBounds, saveWindowBounds } from "./window-state";
import { LocalPiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";

const rendererOrigin = getRendererOrigin();
let runningLocalApi: LocalApiServer | undefined;
let mainWindow: BrowserWindow | undefined;
let openingWindow: Promise<BrowserWindow> | undefined;
let stopping = false;
let rendererNavigationState: DesktopNavigationState = "clear";
let allowWindowClose = false;
let closePromptOpen = false;
const desktopLifecycle = createDesktopLifecycle({
  localApi: {
    async start() {
      const startup = await startLocalApiServer({
        allowedOrigin: rendererOrigin,
        // Never trust the development server origin from a packaged application.
        ...(!app.isPackaged
          ? { developmentOrigin: "http://localhost:5173" }
          : {}),
        capability: createAppCapability(),
        appMetadata: {
          productName: app.name,
          version: app.getVersion(),
          architecture: process.arch,
          distribution: app.isPackaged ? "unsigned_internal" : "development",
        },
        workflowInvoker: createWorkflowInvoker(),
        modelCatalog: new LocalPiRuntimeModelCatalog(),
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
    await ensureWorkbenchWindow(server);
  },
});

function createWorkflowInvoker() {
  const completion = new ReviewCompletionService(
    PatchdeskPaths.default(),
    () => new Date().toISOString() as never,
  );
  const flue = new FlueCliReviewInvoker(
    new CommandRunner(),
    resolveWorkflowRuntimeRoot(app.getAppPath(), process.cwd()),
  );
  return {
    async invoke(
      input: Parameters<FlueCliReviewInvoker["invoke"]>[0],
      options?: Parameters<FlueCliReviewInvoker["invoke"]>[1],
    ) {
      const result = await flue.invoke(input, options);
      if (result._tag === "err") return err({ reason: "failed" as const });
      options?.onActivity?.("drafting");
      const persisted = await completion.complete({
        profileId: input.profileId,
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        result: result.value,
      });
      if (persisted._tag === "err") return err({ reason: "failed" as const });
      // The Flue CLI returns the completed structured result, not a durable
      // provider run identifier. Do not fabricate one from Patchdesk IDs.
      return ok({});
    },
  };
}

app.setName("Patchdesk");
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerDesktopEvents();
}

function registerDesktopEvents(): void {
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...createDesktopMenuTemplate(
          process.platform,
          app.name,
          !app.isPackaged,
          { openSettings: () => requestRendererNavigation("settings") },
        ),
      ]),
    );
    const result = await desktopLifecycle.start();
    if (result._tag === "local-api-unavailable") {
      dialog.showErrorBox(
        "Patchdesk could not start",
        "The local review service is unavailable. No review or GitHub write was started.",
      );
      app.exit(1);
    }
  });

  app.on("second-instance", () => {
    void focusOrRecreateWorkbench().catch(() => undefined);
  });
  app.on("activate", () => {
    void focusOrRecreateWorkbench().catch(() => undefined);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (stopping) return;
    event.preventDefault();
    if (rendererNavigationState === "clear") {
      terminateAfterServerStops();
      return;
    }
    void guardDesktopExit("quit");
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      terminateAfterServerStops();
    });
  }
}

async function ensureWorkbenchWindow(
  server: StartedLocalApi,
): Promise<BrowserWindow> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    focusWindow(mainWindow);
    return mainWindow;
  }
  if (openingWindow !== undefined) return await openingWindow;

  openingWindow = createWorkbenchWindow(server);
  try {
    mainWindow = await openingWindow;
    return mainWindow;
  } finally {
    openingWindow = undefined;
  }
}

async function createWorkbenchWindow(
  server: StartedLocalApi,
): Promise<BrowserWindow> {
  const restoredBounds = await loadWindowBounds(
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const window = new BrowserWindow({
    title: "Patchdesk",
    show: false,
    backgroundColor: "#fafafa",
    ...restoredBounds,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      additionalArguments: [
        `--patchdesk-qa-scroll-diagnostics=${
          !app.isPackaged || process.argv.includes("--patchdesk-qa-scroll-diagnostics")
            ? "1"
            : "0"
        }`,
      ],
      allowRunningInsecureContent: false,
      contextIsolation: true,
      navigateOnDragDrop: false,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      preload: preloadScriptPath(__dirname),
    },
  });
  let boundsTrackingEnabled = false;
  let boundsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const persistCurrentBounds = (): void => {
    if (
      !boundsTrackingEnabled ||
      window.isDestroyed() ||
      window.isMaximized() ||
      window.isFullScreen()
    ) {
      return;
    }
    if (boundsSaveTimer !== undefined) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      boundsSaveTimer = undefined;
      if (!window.isDestroyed()) void saveWindowBounds(window.getBounds());
    }, 250);
  };
  window.on("resize", persistCurrentBounds);
  window.on("move", persistCurrentBounds);
  const allowedHosts = await loadAllowedExternalHosts();
  installDesktopRequestBridge(
    ipcMain,
    window.webContents.id,
    server,
    rendererOrigin,
    {
      setNavigationState(state) {
        rendererNavigationState = state;
      },
      async selectDirectory(input) {
        const result = await dialog.showOpenDialog(window, {
          title: "Choose local repository folder",
          properties: ["openDirectory", "createDirectory"],
          ...(input.defaultPath === undefined
            ? {}
            : { defaultPath: input.defaultPath }),
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
    },
  );
  installWebContentsSecurity(
    window.webContents,
    allowedHosts,
    async (url) => {
      await shell.openExternal(url);
    },
    app.isPackaged,
  );
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) {
      window.show();
      boundsTrackingEnabled = true;
    }
  });
  window.once("closed", () => {
    if (boundsSaveTimer !== undefined) clearTimeout(boundsSaveTimer);
    if (mainWindow === window) {
      mainWindow = undefined;
      rendererNavigationState = "clear";
      allowWindowClose = false;
    }
  });
  window.on("close", (event) => {
    if (allowWindowClose || rendererNavigationState === "clear") return;
    event.preventDefault();
    void guardDesktopExit("window");
  });
  window.webContents.on("render-process-gone", () => {
    void offerRendererRecovery(
      window,
      "The workbench process stopped unexpectedly.",
    );
  });
  window.on("unresponsive", () => {
    void offerRendererRecovery(window, "The workbench stopped responding.");
  });

  try {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl === undefined) {
      await window.loadFile(
        join(__dirname, "../renderer/index.html"),
        process.env.PATCHDESK_PACKAGE_SMOKE === "1"
          ? { hash: "workbench-fixture" }
          : undefined,
      );
    } else {
      await window.loadURL(rendererUrl);
    }
    return window;
  } catch (cause: unknown) {
    if (!window.isDestroyed()) window.destroy();
    throw cause;
  }
}

async function offerRendererRecovery(
  window: BrowserWindow,
  message: string,
): Promise<void> {
  if (window.isDestroyed()) return;
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Patchdesk recovery",
    message,
    detail:
      "Reloading restores saved local state and never retries a GitHub write.",
    buttons: ["Reload Patchdesk", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0 && !window.isDestroyed()) window.reload();
  else app.quit();
}

async function loadAllowedExternalHosts(): Promise<ReadonlySet<string>> {
  const profiles = await new ProfileStore(PatchdeskPaths.default()).list();
  return normalizeExternalHosts([
    "github.com",
    ...(profiles._tag === "ok"
      ? profiles.value.map((profile) => profile.githubHost)
      : []),
  ]);
}

async function focusOrRecreateWorkbench(): Promise<void> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    focusWindow(mainWindow);
    return;
  }
  if (runningLocalApi !== undefined) {
    await ensureWorkbenchWindow(runningLocalApi);
  }
}

function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function requestRendererNavigation(destination: "settings"): void {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  window.webContents.send(DESKTOP_NAVIGATE_CHANNEL, destination);
  focusWindow(window);
}

async function guardDesktopExit(intent: "window" | "quit"): Promise<void> {
  if (closePromptOpen) return;
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  closePromptOpen = true;
  try {
    const decision = await resolveDesktopClose(
      rendererNavigationState,
      async () => {
        const result = await dialog.showMessageBox(window, {
          type: "warning",
          title: "Unsaved review draft",
          message: "Discard the unsaved review draft and close Patchdesk?",
          detail:
            "Saved drafts and review history remain on this Mac. Only the latest unsaved edit will be discarded.",
          buttons: ["Keep reviewing", "Discard unsaved changes"],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      },
    );
    if (decision === "prevent") {
      if (rendererNavigationState === "write_pending") {
        await dialog.showMessageBox(window, {
          type: "info",
          title: "GitHub write in progress",
          message:
            "Patchdesk must receive the final GitHub result before it can close.",
          buttons: ["Wait for completion"],
          defaultId: 0,
        });
      }
      return;
    }
    rendererNavigationState = "clear";
    if (intent === "quit") app.quit();
    else {
      allowWindowClose = true;
      window.close();
    }
  } finally {
    closePromptOpen = false;
  }
}

function getRendererOrigin(): string {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  return rendererUrl === undefined ? "null" : new URL(rendererUrl).origin;
}

function terminateAfterServerStops(): void {
  if (stopping) return;
  stopping = true;
  void desktopLifecycle
    .stop()
    .catch(() => undefined)
    .finally(() => {
      app.exit();
    });
}
