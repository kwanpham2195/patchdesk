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
import {
  answerWindowFullScreenReads,
  sendWindowFullScreen,
} from "./desktop-full-screen-channel";
import { installDesktopRequestBridge } from "./desktop-bridge";
import {
  resolveDesktopClose,
  type DesktopNavigationState,
} from "./desktop-close-guard";
import { preloadScriptPath } from "./electron-paths";
import { rendererOrigin as parseRendererOrigin } from "./renderer-origin";
import {
  installWebContentsSecurity,
  normalizeExternalHosts,
  openAllowedExternalUrl,
} from "./external-navigation";
import { createAppCapability } from "./app-capability";
import { sendMenuAction } from "./desktop-menu-channel";
import type { DesktopMenuAction } from "./ipc-contract";
import {
  healthCheckLocalApi,
  startLocalApiServer,
  type LocalApiServer,
} from "./local-api";
import { CommandRunner } from "../adapters/github/command-runner";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import { ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { ReviewStore } from "../adapters/storage/review-store";
import { InsightStore } from "../adapters/storage/insight-store";
import { parseAbsolutePath, parseGitSha } from "../domain/ids";
import { loggableMetaValue } from "../domain/log-entry";
import { err } from "../domain/result";
import { FlueInsightChildInvoker } from "../services/flue-insight-child-invoker";
import { resolveInsightRuntime } from "./insight-runtime";
import { invokeWalkthroughWithResolvedTimeout } from "../services/child-invocation";
import { ReviewDiagnosticService } from "../services/review-diagnostic-service";
import { AppLogService } from "../services/app-log-service";
import { ReviewLifecycleGate } from "../services/review-lifecycle-gate";
import { ReviewOperationCoordinator } from "../services/review-operation-coordinator";
import { workbenchWindowChrome } from "./window-chrome";
import { loadWindowBounds, saveWindowBounds } from "./window-state";
import { LocalPiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import { CodexAppServerClient } from "../adapters/codex/codex-app-server-client";
import { discoverPathOnlyExecutable } from "../adapters/process/executable-discovery";
import { importLoginShellEnvironment } from "../adapters/process/login-shell-environment";
import { briefReachComputer } from "../services/brief-reach-service";
import { CodexInsightInvoker } from "../services/codex-insight-invoker";
import { InsightProviderCatalog } from "../services/insight-provider-catalog";
import {
  InsightRunCoordinator,
  type InsightInvocationInput,
} from "../services/insight-run-coordinator";

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
const reviewOperations = new ReviewOperationCoordinator();
const logs = new AppLogService(PatchdeskPaths.default(), {
  stdoutMirror:
    !app.isPackaged || process.argv.includes("--patchdesk-tail-logs"),
});
/**
 * Fired by CommandRunner when a nonzero-exit failure matches neither a
 * structured signal nor any regex predicate — a genuinely unclassified
 * failure worth a human noticing (gh wording drift, a new failure shape).
 * AppLogService.write already masks credential shapes and bounds message
 * length; no separate redaction path is built here.
 */
function logUnclassifiedCommandFailure(stderr: string): void {
  logs.write({
    process: "main",
    level: "warn",
    topic: "command-runner",
    message: "unclassified command failure",
    meta: { stderr },
  });
}

const diagnostics = new ReviewDiagnosticService(
  PatchdeskPaths.default(),
  () => new Date().toISOString(),
  undefined,
  {
    mirror: (event) => {
      const durationMsField =
        event.durationMs === undefined ? {} : { durationMs: event.durationMs };
      const meta = {
        category: event.category,
        retryable: event.retryable,
        incidentId: event.incidentId,
        ...durationMsField,
      };
      const profileIdField =
        event.profileId === undefined ? {} : { profileId: event.profileId };
      const sessionIdField =
        event.sessionId === undefined ? {} : { sessionId: event.sessionId };
      logs.write({
        process: "main",
        level: event.retryable ? "warn" : "info",
        topic: "diagnostics",
        message: event.phase,
        meta,
        ...profileIdField,
        ...sessionIdField,
      });
    },
  },
);
const desktopLifecycle = createDesktopLifecycle({
  localApi: {
    async start() {
      const insightProviders =
        createInsightProviderCatalog(runtimeModelCatalog);
      // Never trust the development server origin from a packaged application.
      const developmentOriginField = app.isPackaged
        ? {}
        : { developmentOrigin: "http://localhost:5173" };
      const startup = await startLocalApiServer({
        allowedOrigin: rendererOrigin,
        ...developmentOriginField,
        capability: createAppCapability(),
        appMetadata: {
          productName: app.name,
          version: app.getVersion(),
          architecture: process.arch,
          distribution: app.isPackaged ? "unsigned_internal" : "development",
        },
        insights: await recoverInsights(
          runtimeModelCatalog,
          insightProviders,
          reviewOperations,
        ),
        insightProviders,
        lifecycleGate,
        retentionSweep: true,
        reviewOperations,
        diagnostics,
        logs,
        modelCatalog: runtimeModelCatalog,
        trash: {
          async move(path) {
            try {
              await shell.trashItem(path);
              return { _tag: "ok", value: undefined };
            } catch {
              return {
                _tag: "err",
                error: {
                  _tag: "StorageFailure",
                  operation: "write",
                  reason: "io",
                },
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

function createInsightProviderCatalog(
  modelCatalog: LocalPiRuntimeModelCatalog,
): InsightProviderCatalog {
  return new InsightProviderCatalog(
    modelCatalog,
    (executablePath) => new CodexAppServerClient(executablePath),
    (name) => discoverPathOnlyExecutable(name),
  );
}

function createInsightCoordinator(
  modelCatalog: LocalPiRuntimeModelCatalog,
  providerCatalog: InsightProviderCatalog,
  operations: ReviewOperationCoordinator,
): InsightRunCoordinator {
  const paths = PatchdeskPaths.default();
  const runtime = resolveInsightRuntime(
    app.getAppPath(),
    process.cwd(),
    app.isPackaged,
  );
  logs.write({
    process: "main",
    level: runtime === undefined ? "warn" : "info",
    topic: "insight-runtime",
    message:
      runtime === undefined
        ? "no verified Insight runtime resolved"
        : `Insight runtime resolved from the ${runtime.kind} build`,
    meta: runtime === undefined ? {} : { runnerPath: runtime.runnerPath },
  });
  const insightInvoker =
    runtime === undefined
      ? undefined
      : new FlueInsightChildInvoker(
          new CommandRunner(undefined, logUnclassifiedCommandFailure),
          runtime.root,
          process.execPath,
          runtime.runnerPath,
        );
  const readHead = async (
    worktreePath: string,
  ): Promise<string | undefined> => {
    const output = await new CommandRunner(
      undefined,
      logUnclassifiedCommandFailure,
    ).runText({
      argv: ["git", "-C", worktreePath, "rev-parse", "HEAD"],
      cwd: worktreePath,
      timeoutMs: 10_000,
    });
    if (output._tag === "err") return undefined;
    const parsed = parseGitSha(output.value.trim());
    return parsed._tag === "ok" ? parsed.value : undefined;
  };
  const codexInvoke = async (
    input: InsightInvocationInput,
    options: { readonly signal: AbortSignal },
  ) => {
    const executablePath = await discoverPathOnlyExecutable("codex");
    if (executablePath === undefined)
      return err({ reason: "runtime_unavailable" as const });
    return new CodexInsightInvoker(
      paths,
      (path) => new CodexAppServerClient(path),
      executablePath,
      readHead,
    ).invoke(input, options);
  };
  const analysis = {
    async invoke(
      input: InsightInvocationInput,
      options: { readonly signal: AbortSignal },
    ) {
      if (input.provider === "codex-cli-account")
        return codexInvoke(input, options);
      if (input.reasoning === "minimal" || input.reasoning === "xhigh")
        return err({ reason: "execution_failed" as const });
      if (input.reviewInputPath === undefined)
        return err({ reason: "execution_failed" as const });
      const contextPath = parseAbsolutePath(input.contextPath);
      const reviewInputPath = parseAbsolutePath(input.reviewInputPath);
      const patchPath = parseAbsolutePath(input.patchPath);
      const worktreePath = parseAbsolutePath(input.worktreePath);
      if (
        contextPath._tag === "err" ||
        reviewInputPath._tag === "err" ||
        patchPath._tag === "err" ||
        worktreePath._tag === "err"
      )
        return err({ reason: "execution_failed" as const });
      if (insightInvoker === undefined)
        return err({ reason: "runtime_unavailable" as const });
      return insightInvoker.invokeAnalysis(
        {
          profileId: input.profileId,
          sessionId: input.sessionId,
          contextPath: contextPath.value,
          reviewInputPath: reviewInputPath.value,
          patchPath: patchPath.value,
          worktreePath: worktreePath.value,
          model: input.model,
          reasoning: input.reasoning,
        },
        options,
      );
    },
  };
  const walkthrough = {
    async invoke(
      input: InsightInvocationInput,
      options: { readonly signal: AbortSignal },
    ) {
      if (input.provider === "codex-cli-account")
        return codexInvoke(input, options);
      if (input.reasoning === "minimal" || input.reasoning === "xhigh")
        return err({ reason: "execution_failed" as const });
      if (insightInvoker === undefined)
        return err({ reason: "runtime_unavailable" as const });
      return invokeWalkthroughWithResolvedTimeout(
        insightInvoker,
        {
          profileId: input.profileId,
          sessionId: input.sessionId,
          contextPath: input.contextPath,
          patchPath: input.patchPath,
          model: input.model,
          reasoning: input.reasoning,
        },
        options,
      );
    },
  };
  const brief = {
    async invoke(
      input: InsightInvocationInput,
      options: { readonly signal: AbortSignal },
    ) {
      if (input.provider === "codex-cli-account")
        return codexInvoke(input, options);
      if (input.reasoning === "minimal" || input.reasoning === "xhigh")
        return err({ reason: "execution_failed" as const });
      if (insightInvoker === undefined)
        return err({ reason: "runtime_unavailable" as const });
      return insightInvoker.invokeBrief(
        {
          profileId: input.profileId,
          sessionId: input.sessionId,
          patchPath: input.patchPath,
          model: input.model,
          reasoning: input.reasoning,
          evidence: input.briefEvidence ?? { commits: [] },
        },
        options,
      );
    },
  };
  return new InsightRunCoordinator(
    new ReviewStore(paths),
    new ReviewSessionStore(paths),
    new InsightStore(paths),
    paths,
    modelCatalog,
    { analysis, walkthrough, brief },
    operations,
    undefined,
    diagnostics,
    providerCatalog,
    new ReviewRemoteStore(paths),
    briefReachComputer(
      paths,
      new CommandRunner(undefined, logUnclassifiedCommandFailure),
    ),
  );
}

async function recoverInsights(
  modelCatalog: LocalPiRuntimeModelCatalog,
  providerCatalog: InsightProviderCatalog,
  operations: ReviewOperationCoordinator,
): Promise<InsightRunCoordinator> {
  const coordinator = createInsightCoordinator(
    modelCatalog,
    providerCatalog,
    operations,
  );
  await coordinator.recoverAll();
  return coordinator;
}

/** Imports the login shell's PATH and provider keys into this process, then records what changed by name. */
async function importLoginShellEnvironmentOnce(): Promise<void> {
  const imported = await importLoginShellEnvironment();
  logs.write({
    process: "main",
    level: "info",
    topic: "login-shell-environment",
    message: `imported ${imported.importedNames.length} variables from the login shell`,
    meta: {
      names: imported.importedNames,
      pathReplaced: imported.pathReplaced,
    },
  });
}

app.setName("Patchdesk");
process.on("uncaughtException", (cause: unknown) => {
  logs.write({
    process: "main",
    level: "error",
    topic: "crash",
    message: "Uncaught main-process exception",
    meta: { error: loggableMetaValue(cause) },
  });
  // Record before dying; the previous behavior was an untracked crash.
  void logs.flush().finally(() => app.exit(1));
});
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node's unhandledRejection reason is inherently untyped (a rejected promise can reject with any value); this is the boundary, forwarded straight to logs.write's own sanitizer.
process.on("unhandledRejection", (reason: unknown) => {
  logs.write({
    process: "main",
    level: "error",
    topic: "crash",
    message: "Unhandled main-process rejection",
    meta: { reason: loggableMetaValue(reason) },
  });
  // Preserve the default crash-on-unhandled-rejection behavior after recording.
  setImmediate(() => {
    throw reason;
  });
});
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerDesktopEvents();
}

function registerDesktopEvents(): void {
  void app.whenReady().then(async () => {
    // Before anything reads a provider key or PATH: a Dock or Finder launch
    // inherits the minimal launchd environment, so the login shell is where
    // the maintainer's keys and their `codex` install actually are.
    await importLoginShellEnvironmentOnce();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...createDesktopMenuTemplate(
          process.platform,
          app.name,
          !app.isPackaged,
          {
            openSettings: () => raiseWindowAndSendMenuAction("openSettings"),
            refresh: () => raiseWindowAndSendMenuAction("refresh"),
          },
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
    ...workbenchWindowChrome,
    ...restoredBounds,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      additionalArguments: [
        `--patchdesk-qa-scroll-diagnostics=${
          !app.isPackaged ||
          process.argv.includes("--patchdesk-qa-scroll-diagnostics")
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
        return await openAllowedExternalUrl(
          url,
          allowedHosts,
          async (candidate) => {
            await shell.openExternal(candidate);
          },
        );
      },
      async selectDirectory(input) {
        const defaultPathField =
          input.defaultPath === undefined
            ? {}
            : { defaultPath: input.defaultPath };
        const result = await dialog.showOpenDialog(window, {
          title: "Choose local repository folder",
          properties: ["openDirectory", "createDirectory"],
          ...defaultPathField,
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
    },
  );
  // macOS hides the traffic lights in native full screen, and the renderer
  // cannot see that state for itself, so the main process tells it.
  answerWindowFullScreenReads(ipcMain, window.webContents.id, () =>
    window.isFullScreen(),
  );
  window.on("enter-full-screen", () =>
    sendWindowFullScreen(window.webContents, true),
  );
  window.on("leave-full-screen", () =>
    sendWindowFullScreen(window.webContents, false),
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
  window.webContents.on("render-process-gone", (_event, details) => {
    logs.write({
      process: "main",
      level: "error",
      topic: "renderer",
      message: "Renderer process stopped",
      meta: { reason: details.reason, exitCode: details.exitCode },
    });
    void offerRendererRecovery(
      window,
      "The workbench process stopped unexpectedly.",
    );
  });
  window.on("unresponsive", () => {
    logs.write({
      process: "main",
      level: "warn",
      topic: "renderer",
      message: "Renderer stopped responding",
    });
    void offerRendererRecovery(window, "The workbench stopped responding.");
  });

  try {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl === undefined) {
      await window.loadFile(join(__dirname, "../renderer/index.html"));
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

/**
 * The window-aware wrapper around `sendMenuAction`: a menu item can fire while
 * the workbench is behind another app, so the action is delivered and the
 * window is brought forward. The channel itself lives in
 * `desktop-menu-channel.ts`, which preload reads from too.
 */
function raiseWindowAndSendMenuAction(action: DesktopMenuAction): void {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  sendMenuAction(window.webContents, action);
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
  return parseRendererOrigin(process.env.ELECTRON_RENDERER_URL);
}

function terminateAfterServerStops(): void {
  if (stopping) return;
  stopping = true;
  void desktopLifecycle
    .stop()
    .catch(() => undefined)
    .finally(async () => {
      await logs.flush();
      app.exit();
    });
}
