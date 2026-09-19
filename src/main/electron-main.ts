import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  screen,
  shell,
} from "electron";
import { join } from "node:path";

import {
  createDesktopLifecycle,
  startDesktopBesideLoginShellImport,
  type StartedLocalApi,
} from "./app-lifecycle";
import { createDesktopMenuTemplate } from "./desktop-menu";
import {
  answerWindowFullScreenReads,
  sendWindowFullScreen,
} from "./desktop-full-screen-channel";
import { serveWindowAppearance } from "./desktop-appearance-channel";
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
  openUserActivatedExternalUrl,
} from "./external-navigation";
import { createAppCapability } from "./app-capability";
import { sendMenuAction } from "./desktop-menu-channel";
import { sendNotificationClick } from "./desktop-notification-channel";
import { sendWatchedPullRequestChange } from "./desktop-watched-pull-request-channel";
import {
  createDesktopNotifier,
  type NotificationDestination,
} from "./desktop-notifier";
import type { DesktopMenuAction } from "./ipc-contract";
import {
  healthCheckLocalApi,
  startLocalApiServer,
  type LocalApiServer,
} from "./local-api";
import { githubTransports } from "./local-api-stores";
import { CommandRunner } from "../adapters/github/command-runner";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { ReviewStore } from "../adapters/storage/review-store";
import { InsightStore } from "../adapters/storage/insight-store";
import { GitHubAdapter } from "../adapters/github/github-adapter";
import { GitHubCliCredentials } from "../adapters/github/github-credentials";
import type { GitHubFetch } from "../adapters/github/github-http-client";
import { ReviewContextPackService } from "../services/review-context-pack-service";
import { ReviewContextService } from "../services/review-context-service";
import {
  notificationSettingsOf,
  type Appearance,
  type NotificationSettings,
} from "../domain/contracts";
import { parseGitSha } from "../domain/ids";
import type { InsightProvider } from "../domain/insight-provider";
import { loggableMetaValue } from "../domain/log-entry";
import { err, ok, type Result } from "../domain/result";
import {
  PiInsightChildInvoker,
  unavailablePiInsightInvoker,
} from "../services/pi-insight-child-invoker";
import { resolveInsightRuntime } from "./insight-runtime";
import { ReviewDiagnosticService } from "../services/review-diagnostic-service";
import { AppLogService } from "../services/app-log-service";
import { ReviewLifecycleGate } from "../services/review-lifecycle-gate";
import { ReviewOperationCoordinator } from "../services/review-operation-coordinator";
import { workbenchWindowChrome } from "./window-chrome";
import { windowBackgroundColor } from "./window-appearance";
import { loadWindowBounds, saveWindowBounds } from "./window-state";
import { LocalPiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import { CodexAppServerClient } from "../adapters/codex/codex-app-server-client";
import { discoverPathOnlyExecutable } from "../adapters/process/executable-discovery";
import { importLoginShellEnvironment } from "../adapters/process/login-shell-environment";
import { startLoginShellEnvironmentImport } from "../adapters/process/login-shell-import";
import { briefReachComputer } from "../services/brief-reach-service";
import { CodexInsightInvoker } from "../services/codex-insight-invoker";
import { InsightProviderCatalog } from "../services/insight-provider-catalog";
import {
  InsightRunCoordinator,
  type InsightInvoker,
} from "../services/insight-run-coordinator";

const rendererOrigin = getRendererOrigin();
const runtimeModelCatalog = new LocalPiRuntimeModelCatalog();
let runningLocalApi: LocalApiServer | undefined;
let mainWindow: BrowserWindow | undefined;
let openingWindow: Promise<BrowserWindow> | undefined;
let stopping = false;
let rendererNavigationState: DesktopNavigationState = "clear";
let rendererDestination: NotificationDestination = { kind: "dashboard" };
let allowWindowClose = false;
let closePromptOpen = false;
/**
 * The appearance the window is painted for. Seeded from `config.json` before
 * the window exists, then kept current by the renderer, which is the only
 * side that learns about a change made in Settings.
 */
let storedAppearance: Appearance = "system";
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
/**
 * How the GitHub HTTP client reaches the network in the desktop app:
 * Chromium's stack, which honours the system proxy and the system trust store
 * that `gh` honoured and Node's fetch does not (ADR 0046). Only this entry
 * point knows about Electron, so the local API takes it as configuration and
 * falls back to Node's fetch wherever it runs outside the desktop app.
 *
 * Both options are load-bearing and were measured against Electron 43 rather
 * than assumed. `cache: "no-store"` keeps Chromium's HTTP cache out of the
 * path: GitHub answers an authenticated read with `Cache-Control: private,
 * max-age=60`, and by default a repeat call within that minute is served from
 * the cache without reaching GitHub. `credentials: "omit"` keeps the default
 * session's cookie jar out of it; by default a cookie GitHub set on one
 * response is sent back on the next. The bearer token is a header the client
 * sets itself, so neither is needed to authenticate.
 */
const githubFetch: GitHubFetch = (url, init) =>
  net.fetch(url, { ...init, cache: "no-store", credentials: "omit" });

/** Clicking a notification raises the window before the renderer routes to its Review. */
const desktopNotifier = createDesktopNotifier({
  windowFocused: () =>
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    mainWindow.isFocused(),
  destination: () => rendererDestination,
  settings: loadNotificationSettings,
  createNotification: (options) => new Notification(options),
  onClick(click) {
    const window = mainWindow;
    if (window === undefined || window.isDestroyed()) return;
    focusWindow(window);
    sendNotificationClick(window.webContents, click);
  },
  logs,
});
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
        githubFetch,
        lifecycleGate,
        retentionSweep: true,
        watchedPullRequestPolling: true,
        watchedPullRequestChanged(profileId) {
          const window = mainWindow;
          if (window !== undefined && !window.isDestroyed())
            sendWatchedPullRequestChange(window.webContents, profileId);
        },
        reviewOperations,
        diagnostics,
        logs,
        desktopNotifier,
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
  /**
   * Codex is discovered per run rather than once here: the executable can
   * appear or move between runs, and a PATH lookup is cheaper than a run.
   */
  const codexInvoker: InsightInvoker = {
    async invoke(input, options) {
      const executablePath = await discoverPathOnlyExecutable("codex");
      if (executablePath === undefined)
        return err({ reason: "runtime_unavailable" as const });
      return new CodexInsightInvoker(
        paths,
        (path) => new CodexAppServerClient(path),
        executablePath,
        readHead,
      ).invoke(input, options);
    },
  };
  const providerInvokers = {
    pi:
      runtime === undefined
        ? unavailablePiInsightInvoker
        : new PiInsightChildInvoker(
            new CommandRunner(undefined, logUnclassifiedCommandFailure),
            runtime.root,
            process.execPath,
            runtime.runnerPath,
          ),
    "codex-cli-account": codexInvoker,
  } satisfies Readonly<Record<InsightProvider, InsightInvoker>>;
  /**
   * The one place a provider is chosen. Each run carries the provider it was
   * started with, so the same dispatch serves every Insight type instead of
   * three hand-built objects repeating the same branch.
   */
  const invoker: InsightInvoker = {
    async invoke(input, options) {
      return providerInvokers[input.provider].invoke(input, options);
    },
  };
  // Its own adapter, like the stores above: this function builds the
  // coordinator before the local API container exists to share one.
  const packCommands = new CommandRunner(
    undefined,
    logUnclassifiedCommandFailure,
  );
  const packCredentials = new GitHubCliCredentials(packCommands);
  const packTransports = githubTransports(packCredentials, logs, githubFetch);
  return new InsightRunCoordinator(
    new ReviewStore(paths),
    new ReviewSessionStore(paths),
    new InsightStore(paths),
    paths,
    modelCatalog,
    { analysis: invoker, walkthrough: invoker, brief: invoker },
    operations,
    new ReviewContextPackService({
      profiles: new ProfileStore(paths),
      github: new GitHubAdapter(
        packCommands,
        packCredentials,
        packTransports.shadow,
        packTransports.http,
      ),
      context: new ReviewContextService(),
      paths,
    }),
    undefined,
    diagnostics,
    providerCatalog,
    briefReachComputer(
      paths,
      new CommandRunner(undefined, logUnclassifiedCommandFailure),
    ),
    desktopNotifier,
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
function importLoginShellEnvironmentOnce(): Promise<void> {
  return startLoginShellEnvironmentImport(async () => {
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
    // A Dock or Finder launch inherits the minimal launchd environment, so
    // the login shell is where the maintainer's keys and their `codex`
    // install actually are. Nothing on the way to the window needs them, so
    // the import runs beside the local API and the window rather than before
    // them, and each reader waits for it itself (ADR 0038, amended
    // 2026-09-19).
    const { started, imported } = startDesktopBesideLoginShellImport(
      desktopLifecycle,
      importLoginShellEnvironmentOnce,
    );
    const result = await started;
    if (result._tag === "local-api-unavailable") {
      dialog.showErrorBox(
        "Patchdesk could not start",
        "The local review service is unavailable. No review or GitHub write was started.",
      );
      app.exit(1);
    }
    await imported;
  });

  app.on("second-instance", () => {
    focusOrRecreateWorkbenchLogged("second-instance");
  });
  app.on("activate", () => {
    focusOrRecreateWorkbenchLogged("activate");
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
  const [restoredBounds, appearance] = await Promise.all([
    loadWindowBounds(
      screen.getAllDisplays().map((display) => display.workArea),
    ),
    loadStoredAppearance(),
  ]);
  storedAppearance = appearance;
  const window = new BrowserWindow({
    title: "Patchdesk",
    show: false,
    backgroundColor: windowBackgroundColor(
      storedAppearance,
      nativeTheme.shouldUseDarkColors,
    ),
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
      setNavigationDestination(destination) {
        rendererDestination = destination;
      },
      // The renderer only reaches this after the user clicked a link, so it
      // allows any HTTPS host. `installWebContentsSecurity` below keeps the
      // allowlist for navigation the page starts by itself.
      async openExternalHttps(url) {
        return await openUserActivatedExternalUrl(url, async (candidate) => {
          await shell.openExternal(candidate);
        });
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
  const paintWindowBackground = (): void => {
    if (window.isDestroyed()) return;
    window.setBackgroundColor(
      windowBackgroundColor(storedAppearance, nativeTheme.shouldUseDarkColors),
    );
  };
  serveWindowAppearance(ipcMain, window.webContents.id, {
    current: () => storedAppearance,
    update: (next) => {
      storedAppearance = next;
      paintWindowBackground();
    },
  });
  // A "system" window follows the OS the same way the renderer's
  // `prefers-color-scheme` listener does.
  nativeTheme.on("updated", paintWindowBackground);
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
    rendererOrigin,
  );
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) {
      window.show();
      boundsTrackingEnabled = true;
    }
  });
  window.once("closed", () => {
    nativeTheme.off("updated", paintWindowBackground);
    if (boundsSaveTimer !== undefined) clearTimeout(boundsSaveTimer);
    if (mainWindow === window) {
      mainWindow = undefined;
      rendererNavigationState = "clear";
      rendererDestination = { kind: "dashboard" };
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

/** The stored appearance, or "system" when no config file names one yet. */
async function loadStoredAppearance(): Promise<Appearance> {
  const config = await new ProfileStore(PatchdeskPaths.default()).loadConfig();
  return config._tag === "ok"
    ? (config.value.appearance ?? "system")
    : "system";
}

/** The stored notification toggles; a missing config file is a first run with the defaults. */
async function loadNotificationSettings(): Promise<
  Result<NotificationSettings, "config_unreadable">
> {
  const config = await new ProfileStore(PatchdeskPaths.default()).loadConfig();
  if (config._tag === "ok") return ok(notificationSettingsOf(config.value));
  return config.error.reason === "not_found"
    ? ok(notificationSettingsOf({}))
    : err("config_unreadable");
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

/** Records which trigger failed, so a dock click that opens nothing leaves a trace. */
function focusOrRecreateWorkbenchLogged(
  trigger: "second-instance" | "activate",
): void {
  void focusOrRecreateWorkbench().catch((cause: unknown) => {
    logs.write({
      process: "main",
      level: "error",
      topic: "desktop",
      message: "Workbench could not be focused or recreated",
      meta: { trigger, error: loggableMetaValue(cause) },
    });
  });
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
    .catch((cause: unknown) => {
      logs.write({
        process: "main",
        level: "error",
        topic: "desktop",
        message: "Desktop lifecycle did not stop cleanly",
        meta: { error: loggableMetaValue(cause) },
      });
    })
    .finally(async () => {
      await logs.flush();
      app.exit();
    });
}
