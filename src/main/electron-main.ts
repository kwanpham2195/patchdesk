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
  openAllowedExternalUrl,
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
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { ReviewStore } from "../adapters/storage/review-store";
import { InsightStore } from "../adapters/storage/insight-store";
import { PublicationAuthorizationStore } from "../adapters/storage/publication-authorization-store";
import { parseAbsolutePath } from "../domain/ids";
import { err, ok } from "../domain/result";
import { FlueCliReviewInvoker, type FlueCliReviewFailure } from "../services/flue-cli-review-invoker";
import { FlueCliWalkthroughInvoker } from "../services/flue-cli-walkthrough-invoker";
import { resolveWorkflowCliPath, resolveWorkflowRuntimeRoot } from "./workflow-runtime-root";
import { ReviewCompletionService } from "../services/review-completion-service";
import { ReviewFailureService } from "../services/review-failure-service";
import { ReviewDiagnosticService } from "../services/review-diagnostic-service";
import { ReviewLifecycleGate } from "../services/review-lifecycle-gate";
import { loadWindowBounds, saveWindowBounds } from "./window-state";
import { LocalPiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import { InsightRunCoordinator, type InsightInvocationInput } from "../services/insight-run-coordinator";

const rendererOrigin = getRendererOrigin();
const runtimeModelCatalog = new LocalPiRuntimeModelCatalog();
let runningLocalApi: LocalApiServer | undefined;
let mainWindow: BrowserWindow | undefined;
let openingWindow: Promise<BrowserWindow> | undefined;
let stopping = false;
let rendererNavigationState: DesktopNavigationState = "clear";
let allowWindowClose = false;
let closePromptOpen = false;
const lifecycleGate = new ReviewLifecycleGate();
const diagnostics = new ReviewDiagnosticService(
  PatchdeskPaths.default(),
  () => new Date().toISOString(),
);
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
        workflowInvoker: createWorkflowInvoker(lifecycleGate, diagnostics),
        insights: await recoverInsights(runtimeModelCatalog),
        lifecycleGate,
        diagnostics,
        modelCatalog: runtimeModelCatalog,
        trash: {
          async move(path) {
            try {
              await shell.trashItem(path);
              return { _tag: "ok", value: undefined };
            } catch {
              return {
                _tag: "err",
                error: { _tag: "StorageFailure", operation: "write", reason: "io" },
              };
            }
          },
        },
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

function createInsightCoordinator(modelCatalog: LocalPiRuntimeModelCatalog): InsightRunCoordinator {
  const paths = PatchdeskPaths.default();
  const workflowRoot = resolveWorkflowRuntimeRoot(app.getAppPath(), process.cwd());
  const reviewInvoker = new FlueCliReviewInvoker(new CommandRunner(), workflowRoot, process.execPath, resolveWorkflowCliPath(workflowRoot));
  const walkthroughInvoker = new FlueCliWalkthroughInvoker(new CommandRunner(), workflowRoot, process.execPath, resolveWorkflowCliPath(workflowRoot));
  const analysis = {
    async invoke(input: InsightInvocationInput, options: { readonly signal: AbortSignal }) {
      if (input.reviewInputPath === undefined || input.scope === undefined) return err({ reason: "execution_failed" as const });
      const contextPath = parseAbsolutePath(input.contextPath);
      const reviewInputPath = parseAbsolutePath(input.reviewInputPath);
      const patchPath = parseAbsolutePath(input.patchPath);
      const worktreePath = parseAbsolutePath(input.worktreePath);
      if (contextPath._tag === "err" || reviewInputPath._tag === "err" || patchPath._tag === "err" || worktreePath._tag === "err") return err({ reason: "execution_failed" as const });
      return reviewInvoker.invoke({ profileId: input.profileId, sessionId: input.sessionId, ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }), contextPath: contextPath.value, reviewInputPath: reviewInputPath.value, patchPath: patchPath.value, worktreePath: worktreePath.value, scope: input.scope, model: input.model, reasoning: input.reasoning }, options);
    },
  };
  const walkthrough = {
    async invoke(input: InsightInvocationInput, options: { readonly signal: AbortSignal }) {
      return walkthroughInvoker.invoke({ profileId: input.profileId, sessionId: input.sessionId, contextPath: input.contextPath, patchPath: input.patchPath, model: input.model, reasoning: input.reasoning }, options);
    },
  };
  return new InsightRunCoordinator(new ReviewStore(paths), new ReviewSessionStore(paths), new InsightStore(paths), paths, modelCatalog, { analysis, walkthrough }, undefined, diagnostics, new PublicationAuthorizationStore(paths));
}

async function recoverInsights(modelCatalog: LocalPiRuntimeModelCatalog): Promise<InsightRunCoordinator> {
  const coordinator = createInsightCoordinator(modelCatalog);
  await coordinator.recoverAll();
  return coordinator;
}

function createWorkflowInvoker(
  sharedLifecycleGate: ReviewLifecycleGate,
  diagnostics: ReviewDiagnosticService,
) {
  const workflowRoot = resolveWorkflowRuntimeRoot(app.getAppPath(), process.cwd());
  const completion = new ReviewCompletionService(
    PatchdeskPaths.default(),
    () => new Date().toISOString() as never,
    sharedLifecycleGate,
  );
  const failure = new ReviewFailureService(
    PatchdeskPaths.default(),
    () => new Date().toISOString() as never,
    sharedLifecycleGate,
    diagnostics,
  );
  const flue = new FlueCliReviewInvoker(
    new CommandRunner(),
    workflowRoot,
    process.execPath,
    resolveWorkflowCliPath(workflowRoot),
  );
  return {
    async invoke(
      input: Parameters<FlueCliReviewInvoker["invoke"]>[0],
      options?: Parameters<FlueCliReviewInvoker["invoke"]>[1],
    ) {
      const startedAt = Date.now();
      let diagnosticWrites = Promise.resolve();
      const record = (
        phase: string,
        retryable: boolean,
        detail?: string,
        durationMs?: number,
      ): void => {
        diagnosticWrites = diagnosticWrites.then(async () => {
          try {
            await diagnostics.record({
              profileId: input.profileId,
              sessionId: input.sessionId,
              ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
              category: "run",
              phase,
              retryable,
              ...(detail === undefined ? {} : { detail }),
              ...(durationMs === undefined ? {} : { durationMs }),
            });
          } catch {
            // Workflow completion must not depend on best-effort local activity.
          }
        });
      };
      record("workflow-started", true);
      const result = await flue.invoke(input, {
        onActivity: (step) => {
          record(`workflow-${step}`, true);
          options?.onActivity?.(step);
        },
      });
      await diagnosticWrites;
      if (result._tag === "err") {
        const message = reviewFailureMessage(result.error.reason);
        record("workflow-failed", true, `review_${result.error.reason}`, Date.now() - startedAt);
        await diagnosticWrites;
        // Best effort: if this write fails, startup reconciliation is the backstop.
        await failure.fail({
          profileId: input.profileId,
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          category: "flue",
          message,
        });
        return err({ reason: "failed" as const });
      }
      options?.onActivity?.("drafting");
      record("workflow-drafting", true);
      await diagnosticWrites;
      const persisted = await completion.complete({
        profileId: input.profileId,
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        result: result.value,
      });
      if (persisted._tag === "err") {
        record("workflow-save-failed", true, "review_result_storage_unavailable", Date.now() - startedAt);
        await diagnosticWrites;
        await failure.fail({
          profileId: input.profileId,
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          category: "unknown",
          message: "The review result could not be saved.",
        });
        return err({ reason: "failed" as const });
      }
      record("workflow-completed", false, undefined, Date.now() - startedAt);
      await diagnosticWrites;
      // The Flue CLI returns the completed structured result, not a durable
      // provider run identifier. Do not fabricate one from Patchdesk IDs.
      return ok({});
    },
  };
}

function reviewFailureMessage(reason: FlueCliReviewFailure["reason"]): string {
  switch (reason) {
    case "cancelled": return "The review was cancelled.";
    case "authentication_required": return "The selected review model needs sign-in before it can run.";
    case "rate_limited": return "The selected review model is rate limited. Try again shortly or choose another model.";
    case "runtime_unavailable": return "Patchdesk could not start its local review runtime. Repackage or reinstall the app, then try again.";
    case "timed_out": return "The selected review model did not finish before the review timed out.";
    case "invalid_result": return "The selected review model returned a result Patchdesk could not use.";
    case "execution_failed": return "The selected review model stopped before it returned a review.";
  }
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
      async openExternalHttps(url) {
        return await openAllowedExternalUrl(url, allowedHosts, async (candidate) => {
          await shell.openExternal(candidate);
        });
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
