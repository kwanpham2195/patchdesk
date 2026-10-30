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
import { randomUUID } from "node:crypto";
import { guideReadingAdmissionRequests } from "./guide-reading-flush-channel";
import { DesktopRendererRecovery } from "./desktop-renderer-recovery";
import {
  DesktopOrderlyClose,
  desktopCloseDialogs,
  holdDesktopCloseInput,
} from "./desktop-orderly-close";

import {
  createDesktopLifecycle,
  startDesktopBesideLoginShellImport,
  type StartedLocalApi,
  upgradeRefusalMessage,
} from "./app-lifecycle";
import { createDesktopMenuTemplate } from "./desktop-menu";
import { createDesktopInsightArtifactLifecycle } from "./desktop-insight-artifact-lifecycle";
import {
  insightContextPackFactory,
  insightCoordinatorFactory,
} from "./insight-coordinator-composition";
import {
  answerWindowFullScreenReads,
  sendWindowFullScreen,
} from "./desktop-full-screen-channel";
import { serveWindowAppearance } from "./desktop-appearance-channel";
import { installDesktopRequestBridge } from "./desktop-bridge";
import { type DesktopNavigationState } from "./desktop-close-guard";
import { preloadScriptPath } from "./electron-paths";
import { rendererSource } from "./renderer-origin";
import {
  installWebContentsSecurity,
  openUserActivatedExternalUrl,
} from "./external-navigation";
import { createAppCapability } from "./app-capability";
import { answerAppUpdateReads } from "./desktop-app-update-channel";
import { createDesktopAppUpdate } from "./desktop-app-update";
import {
  loadAllowedExternalHosts,
  loadNotificationSettings,
  loadStoredAppearance,
} from "./desktop-config-reads";
import { sendMenuAction } from "./desktop-menu-channel";
import { sendInsightSettled } from "./desktop-insight-settled-channel";
import { sendReviewsRemoved } from "./desktop-reviews-removed-channel";
import { sendNotificationClick } from "./desktop-notification-channel";
import { createReviewWindow } from "./desktop-review-window";
import { sendWatchedPullRequestChange } from "./desktop-watched-pull-request-channel";
import {
  createDesktopNotifier,
  type NotificationDestination,
} from "./desktop-notifier";
import type { DesktopNotifier } from "#src/services/desktop-notifier";
import type { DesktopMenuAction } from "./ipc-contract";
import {
  healthCheckLocalApi,
  startLocalApiServer,
  type LocalApiServer,
} from "./local-api";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { desktopMcpSocketPath } from "./mcp/mcp-socket-listener";
import type { InsightResourceBundle } from "#src/services/insight-resource-bundle";
import type { GitHubReader } from "#src/adapters/github/github-adapter";
import type { GitHubFetch } from "#src/adapters/github/github-http-client";
import type { Appearance } from "#src/domain/contracts";
import { loggableMetaValue } from "#src/domain/log-entry";
import { ReviewDiagnosticService } from "#src/services/review-diagnostic-service";
import { AppLogService } from "#src/services/app-log-service";
import { ReviewLifecycleGate } from "#src/services/review-lifecycle-gate";
import { ReviewOperationCoordinator } from "#src/services/review-operation-coordinator";
import { workbenchWindowChrome } from "./window-chrome";
import { windowBackgroundColor } from "./window-appearance";
import { loadWindowBounds, saveWindowBounds } from "./window-state";
import { CodexAppServerClient } from "#src/adapters/codex/codex-app-server-client";
import { PiRpcClient } from "#src/adapters/pi-cli/pi-rpc-client";
import { discoverPathOnlyExecutable } from "#src/adapters/process/executable-discovery";
import { importLoginShellEnvironment } from "#src/adapters/process/login-shell-environment";
import { startLoginShellEnvironmentImport } from "#src/adapters/process/login-shell-import";
import { InsightProviderCatalog } from "#src/services/insight-provider-catalog";
import type { InsightRunCoordinator } from "#src/services/insight-run-coordinator";
import type { InsightCaptureDiagnostics } from "./desktop-insight-capture-diagnostics";

const renderer = rendererSource(process.env, app.isPackaged);
const rendererOrigin = renderer.origin;
let runningLocalApi: LocalApiServer | undefined;
let captureDiagnostics: InsightCaptureDiagnostics | undefined;
let captureDiagnosticsStarting: Promise<void> | undefined;
let captureDiagnosticsClosed = false;
let captureDiagnosticsDisposal: Promise<void> | undefined;
let mainWindow: BrowserWindow | undefined;
let openingWindow: Promise<BrowserWindow> | undefined;
let stopping = false;
let rendererNavigationState: DesktopNavigationState = "clear";
let rendererDestination: NotificationDestination = { kind: "dashboard" };
let allowWindowClose = false;
let quitApproved = false;
/** Settles when a window's renderer first reports its destination, by which time its notification-click listener is subscribed. */
const rendererListening = new WeakMap<BrowserWindow, Promise<void>>();
/**
 * The appearance the window is painted for. Seeded from `config.json` before
 * the window exists, then kept current by the renderer, which is the only
 * side that learns about a change made in Settings.
 */
let storedAppearance: Appearance = "system";
const lifecycleGate = new ReviewLifecycleGate();
const reviewOperations = new ReviewOperationCoordinator();
/** Every app-owned path this process uses; unpackaged builds keep `-dev` roots of their own (#804). */
const paths = PatchdeskPaths.forBuild({
  packaged: app.isPackaged,
  environment: process.env,
});
const logs = new AppLogService(paths, {
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
  paths,
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
 *
 * Writes accept Chromium's transparent resend of a POST as a known risk rather
 * than avoiding it (ADR 0046).
 */
const githubFetch: GitHubFetch = (url, init) =>
  net.fetch(url, { ...init, cache: "no-store", credentials: "omit" });
const appUpdate = createDesktopAppUpdate({
  paths,
  runningVersion: app.getVersion(),
  packaged: app.isPackaged,
  githubFetch,
  logs,
  renderer: () =>
    mainWindow?.isDestroyed() === false ? mainWindow.webContents : undefined,
  quit: () => app.quit(),
});

/** Clicking a notification raises the window before the renderer routes to its Review. */
const systemNotifier = createDesktopNotifier({
  windowFocused: () =>
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    mainWindow.isFocused(),
  destination: () => rendererDestination,
  settings: () => loadNotificationSettings(paths),
  createNotification: (options) => new Notification(options),
  onClick(click) {
    const window = mainWindow;
    if (window === undefined || window.isDestroyed()) return;
    focusWindow(window);
    sendNotificationClick(window.webContents, click);
  },
  logs,
});
/**
 * The one hook every settled Insight run passes through, whatever the
 * notification settings say: the same event also tells the window to re-read
 * the Insight state its Pull requests rows show.
 */
const desktopNotifier: DesktopNotifier = {
  notify(event) {
    systemNotifier.notify(event);
    if (event._tag !== "InsightSettled") return;
    const window = mainWindow;
    if (window !== undefined && !window.isDestroyed())
      sendInsightSettled(window.webContents);
  },
};
/** MCP `show_review`: switches the window's screen without raising it, opening one inactive when none is open. */
const reviewWindow = createReviewWindow({
  navigationState: () => rendererNavigationState,
  async listeningRenderer() {
    const server = runningLocalApi;
    if (server === undefined) return undefined;
    try {
      const window = await ensureWorkbenchWindow(server, "inactive");
      const listening = rendererListening.get(window);
      if (listening === undefined) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const listened = await Promise.race([
        listening.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 20_000);
        }),
      ]);
      clearTimeout(timer);
      return listened && !window.isDestroyed() ? window.webContents : undefined;
    } catch (cause: unknown) {
      logs.write({
        process: "main",
        level: "error",
        topic: "mcp",
        message: "show_review could not open the window",
        meta: { error: loggableMetaValue(cause) },
      });
      return undefined;
    }
  },
});
const artifactApiLifecycle = createDesktopInsightArtifactLifecycle(
  new URL("./", import.meta.url),
  async (insightResources) => {
    const insightProviders = createInsightProviderCatalog();
    if (__PATCHDESK_CAPTURE_DIAGNOSTICS__ && !app.isPackaged) {
      if (captureDiagnosticsClosed || stopping)
        return { _tag: "recovery-failed" };
      captureDiagnosticsStarting = (async () => {
        const { createInsightCaptureDiagnostics } =
          await import("./desktop-insight-capture-diagnostics");
        if (!captureDiagnosticsClosed && !stopping) {
          captureDiagnostics = createInsightCaptureDiagnostics(
            paths,
            insightResources,
            reviewOperations,
            app.isPackaged,
            process.env,
          );
        }
      })();
      await captureDiagnosticsStarting;
      if (captureDiagnosticsClosed || stopping)
        return { _tag: "recovery-failed" };
    }
    // Never trust the development server origin from a packaged application.
    const developmentOriginField = app.isPackaged
      ? {}
      : { developmentOrigin: "http://localhost:5173" };
    const startup = await startLocalApiServer({
      allowedOrigin: rendererOrigin,
      ...developmentOriginField,
      capability: createAppCapability(),
      insightResources,
      appMetadata: {
        productName: app.name,
        version: app.getVersion(),
        architecture: process.arch,
        distribution: app.isPackaged ? "unsigned_internal" : "development",
      },
      insights: (github) =>
        recoverInsights(
          insightProviders,
          reviewOperations,
          github,
          insightResources,
        ),
      insightProviders,
      githubFetch,
      paths,
      mcpSocketPath: () => desktopMcpSocketPath(paths),
      reviewWindow,
      lifecycleGate,
      retentionSweep: true,
      reviewsRemovedBySweep() {
        const window = mainWindow;
        if (window !== undefined && !window.isDestroyed())
          sendReviewsRemoved(window.webContents);
      },
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
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Startup promise rejection is an untyped boundary, rethrown after consumer cleanup.
    }).catch(async (cause: unknown) => {
      if (__PATCHDESK_CAPTURE_DIAGNOSTICS__) await disposeCaptureDiagnostics();
      throw cause;
    });
    if (
      __PATCHDESK_CAPTURE_DIAGNOSTICS__ &&
      (stopping || startup._tag !== "started")
    )
      await disposeCaptureDiagnostics();
    if (!stopping && startup._tag === "started") {
      runningLocalApi = startup.server;
    }

    return startup;
  },
  logs,
);
const desktopLifecycle = createDesktopLifecycle({
  localApi: {
    start: artifactApiLifecycle.start,
    async healthCheck(server) {
      return await healthCheckLocalApi(server, rendererOrigin);
    },
    async stop() {
      runningLocalApi = undefined;
      await stopArtifactApi();
    },
  },
  async showWorkbench(server) {
    if (!stopping) await ensureWorkbenchWindow(server);
  },
});

function disposeCaptureDiagnostics(): Promise<void> {
  if (captureDiagnosticsDisposal !== undefined)
    return captureDiagnosticsDisposal;
  captureDiagnosticsClosed = true;
  const owned = captureDiagnostics;
  captureDiagnostics = undefined;
  const finishing = owned?.dispose();
  // Closing publication before joining startup prevents a late owner after an initially empty cleanup.
  captureDiagnosticsDisposal = (async () => {
    try {
      await captureDiagnosticsStarting;
    } finally {
      await finishing;
    }
  })();
  return captureDiagnosticsDisposal;
}

async function stopArtifactApi(): Promise<void> {
  try {
    if (__PATCHDESK_CAPTURE_DIAGNOSTICS__) await disposeCaptureDiagnostics();
  } finally {
    await artifactApiLifecycle.stop();
  }
}

function createInsightProviderCatalog(): InsightProviderCatalog {
  return new InsightProviderCatalog(
    (executablePath) => new CodexAppServerClient(executablePath),
    (executablePath) => new PiRpcClient(executablePath),
    (name) => discoverPathOnlyExecutable(name),
  );
}

const createContextPack = insightContextPackFactory({
  paths,
  logUnclassifiedCommandFailure,
});
const createInsightCoordinator = insightCoordinatorFactory({
  paths,
  logs,
  logUnclassifiedCommandFailure,
  diagnostics,
  desktopNotifier,
});

async function recoverInsights(
  providerCatalog: InsightProviderCatalog,
  operations: ReviewOperationCoordinator,
  github: GitHubReader,
  insightResources: InsightResourceBundle,
): Promise<InsightRunCoordinator> {
  if (__PATCHDESK_CAPTURE_DIAGNOSTICS__)
    captureDiagnostics?.connectContext(createContextPack(github));
  const coordinator = createInsightCoordinator(
    providerCatalog,
    operations,
    github,
    insightResources,
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
// Electron keys the single-instance lock on userData, so a separate dev profile lets an installed Patchdesk run beside `pnpm dev`. PatchdeskPaths split the same way (`-dev` roots), unless PATCHDESK_DEV_SHARED=1 (#804).
if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir"))
  app.setPath("userData", join(app.getPath("appData"), "Patchdesk Dev"));
logs.write({
  process: "main",
  level: "info",
  topic: "paths",
  message: "app roots in use",
  meta: { packaged: app.isPackaged, ...paths.rootsEnvironment() },
});
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
            openDiagnostics: () =>
              raiseWindowAndSendMenuAction("openDiagnostics"),
            refresh: () => raiseWindowAndSendMenuAction("refresh"),
            find: () => raiseWindowAndSendMenuAction("find"),
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
    if (!stopping && result._tag === "upgrade-refused") {
      dialog.showErrorBox(
        "Patchdesk could not start",
        upgradeRefusalMessage(result.detail, paths),
      );
      app.exit(1);
    }
    if (!stopping && result._tag === "local-api-unavailable") {
      dialog.showErrorBox(
        "Patchdesk could not start",
        "The local review service is unavailable. No review or GitHub write was started.",
      );
      app.exit(1);
    }
    if (!stopping) appUpdate.start();
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
    void orderlyClose.beforeQuit(
      event,
      { stopping, quitApproved },
      terminateAfterServerStops,
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      terminateAfterServerStops();
    });
  }
}

/** `inactive` never raises or focuses the window, and shows a new one with `showInactive` (MCP `show_review`). */
async function ensureWorkbenchWindow(
  server: StartedLocalApi,
  activation: "focus" | "inactive" = "focus",
): Promise<BrowserWindow> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (activation === "focus") focusWindow(mainWindow);
    return mainWindow;
  }
  if (openingWindow !== undefined) return await openingWindow;

  openingWindow = createWorkbenchWindow(server, activation);
  try {
    mainWindow = await openingWindow;
    return mainWindow;
  } finally {
    openingWindow = undefined;
  }
}

async function createWorkbenchWindow(
  server: StartedLocalApi,
  activation: "focus" | "inactive",
): Promise<BrowserWindow> {
  const [restoredBounds, appearance] = await Promise.all([
    loadWindowBounds(
      paths,
      screen.getAllDisplays().map((display) => display.workArea),
    ),
    loadStoredAppearance(paths),
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
        ...(__PATCHDESK_CAPTURE_DIAGNOSTICS__ &&
        captureDiagnostics !== undefined
          ? ["--patchdesk-insight-patch-capture=1"]
          : []),
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
      if (!window.isDestroyed())
        void saveWindowBounds(paths, window.getBounds());
    }, 250);
  };
  window.on("resize", persistCurrentBounds);
  window.on("move", persistCurrentBounds);
  const allowedHosts = await loadAllowedExternalHosts(paths);
  let markRendererListening = (): void => undefined;
  rendererListening.set(
    window,
    new Promise<void>((resolve) => {
      markRendererListening = resolve;
    }),
  );
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
        markRendererListening();
      },
      // The renderer only reaches this after the user clicked a link, so it
      // allows any HTTPS host. `installWebContentsSecurity` below keeps the
      // allowlist for navigation the page starts by itself.
      async openExternalHttps(url) {
        return await openUserActivatedExternalUrl(url, async (candidate) => {
          await shell.openExternal(candidate);
        });
      },
      ...appUpdate.bridgeOperations,
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
  if (__PATCHDESK_CAPTURE_DIAGNOSTICS__)
    captureDiagnostics?.install(window, rendererOrigin);
  // macOS hides the traffic lights in native full screen, and the renderer
  // cannot see that state for itself, so the main process tells it.
  answerWindowFullScreenReads(ipcMain, window.webContents.id, () =>
    window.isFullScreen(),
  );
  answerAppUpdateReads(ipcMain, window.webContents.id, () =>
    appUpdate.service.state(),
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
    if (!stopping && !window.isDestroyed()) {
      if (activation === "focus") window.show();
      else window.showInactive();
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
    if (allowWindowClose || stopping) return;
    event.preventDefault();
    void orderlyClose.request("window");
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logs.write({
      process: "main",
      level: "error",
      topic: "renderer",
      message: "Renderer process stopped",
      meta: { reason: details.reason, exitCode: details.exitCode },
    });
    void rendererRecovery.offer(
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
    void rendererRecovery.offer(window, "The workbench stopped responding.");
  });

  try {
    if (renderer.url === undefined) {
      await window.loadFile(join(__dirname, "../renderer/index.html"));
    } else {
      await window.loadURL(renderer.url);
    }
    return window;
  } catch (cause: unknown) {
    if (!window.isDestroyed()) window.destroy();
    throw cause;
  }
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
  if (stopping) return;
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

const orderlyClose = new DesktopOrderlyClose({
  ...guideReadingAdmissionRequests(
    ipcMain,
    () => mainWindow?.webContents,
    randomUUID,
    30_000,
  ),
  holdInput: () =>
    mainWindow === undefined
      ? () => undefined
      : holdDesktopCloseInput(
          mainWindow.webContents,
          Menu.getApplicationMenu(),
        ),
  ...desktopCloseDialogs(async (options) => {
    const window = mainWindow;
    return window === undefined || window.isDestroyed()
      ? { response: 0 }
      : await dialog.showMessageBox(window, options);
  }),

  cancelInstall: () => appUpdate.service.cancelInstall(),
  complete(intent) {
    rendererNavigationState = "clear";
    if (intent === "quit") {
      quitApproved = true;
      app.quit();
    } else {
      appUpdate.service.cancelInstall();
      allowWindowClose = true;
      mainWindow?.close();
    }
  },
});

const rendererRecovery = new DesktopRendererRecovery<BrowserWindow>({
  current: () => mainWindow,
  isFailed: (window) => window.webContents.isCrashed(),
  navigationState: () => rendererNavigationState,
  show: dialog.showMessageBox,
  dialogs: desktopCloseDialogs(async (options) =>
    mainWindow === undefined || mainWindow.isDestroyed()
      ? { response: 0 }
      : dialog.showMessageBox(mainWindow, options),
  ),
  cancelInstall: () => appUpdate.service.cancelInstall(),
  requestQuit: () => app.quit(),
  approveQuit() {
    quitApproved = true;
    app.quit();
  },
});

function terminateAfterServerStops(): void {
  if (stopping) return;
  stopping = true;
  runningLocalApi = undefined;
  void stopArtifactApi()
    .finally(() => desktopLifecycle.stop())
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
      await appUpdate.service.startInstallBeforeExit();
      await logs.flush();
      app.exit();
    });
}
