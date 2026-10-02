import { existsSync } from "node:fs";

import { fetchLatestPatchdeskRelease } from "../adapters/github/github-latest-release";
import type { GitHubFetch } from "../adapters/github/github-http-client";
import {
  findHomebrewInstall,
  homebrewUpdateHelperCommand,
  startHomebrewUpdateHelper,
} from "../adapters/process/homebrew-update-helper";
import { AppUpdateStateStore } from "../adapters/storage/app-update-state-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import { definedProps } from "../domain/defined-props";
import { loggableMetaValue, type LogEntryInput } from "../domain/log-entry";
import { AppUpdateService } from "../services/app-update-service";
import {
  sendAppUpdate,
  type AppUpdateSender,
} from "./desktop-app-update-channel";

/** The release check runs at launch and then once a day while the app runs. */
const APP_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The in-app update as `electron-main.ts` wires it (#800). */
type DesktopAppUpdate = {
  readonly service: AppUpdateService;
  /** The desktop request bridge's Dismiss and Update now. */
  readonly bridgeOperations: {
    readonly dismissAppUpdate: (notice: "available" | "launch") => void;
    readonly installAppUpdate: () => void;
  };
  /** Reports the previous update and starts the daily check; development builds skip both. */
  readonly start: () => void;
};

export function createDesktopAppUpdate(input: {
  readonly paths: PatchdeskPaths;
  readonly runningVersion: string;
  readonly packaged: boolean;
  readonly githubFetch: GitHubFetch;
  readonly logs: { readonly write: (entry: LogEntryInput) => void };
  /** The window's `webContents`, while one is open. */
  readonly renderer: () => AppUpdateSender | undefined;
  /** `app.quit()`, which runs the close guard. */
  readonly quit: () => void;
}): DesktopAppUpdate {
  const logPath = input.paths.appUpdateLogFile();
  const service = new AppUpdateService({
    runningVersion: input.runningVersion,
    store: new AppUpdateStateStore(input.paths),
    async checkEnabled() {
      const config = await new ProfileStore(input.paths).loadConfig();
      if (config._tag === "ok") return config.value.checkForUpdates ?? true;
      return config.error.reason === "not_found";
    },
    fetchLatestRelease: () => fetchLatestPatchdeskRelease(input.githubFetch),
    homebrewBrewPath: findHomebrewInstall(existsSync),
    logPath,
    async startHelper(brewPath) {
      try {
        await startHomebrewUpdateHelper(
          homebrewUpdateHelperCommand({
            brewPath,
            appPid: process.pid,
            logPath,
          }),
        );
        input.logs.write({
          process: "main",
          level: "info",
          topic: "app-update",
          message: "update helper started",
          meta: { brewPath, logPath },
        });
      } catch (cause: unknown) {
        input.logs.write({
          process: "main",
          level: "error",
          topic: "app-update",
          message: "update helper could not start",
          meta: { error: loggableMetaValue(cause) },
        });
      }
    },
    publish(state) {
      const renderer = input.renderer();
      if (renderer !== undefined) sendAppUpdate(renderer, state);
    },
    warn(failure) {
      input.logs.write({
        process: "main",
        level: "warn",
        topic: "app-update",
        message: "update check failed",
        meta: definedProps({ reason: failure.reason, status: failure.status }),
      });
    },
  });
  const logStopped = (cause: unknown): void => {
    input.logs.write({
      process: "main",
      level: "warn",
      topic: "app-update",
      message: "update check stopped",
      meta: { error: loggableMetaValue(cause) },
    });
  };
  const check = (): void => {
    void service.check().catch(logStopped);
  };
  return {
    service,
    bridgeOperations: {
      dismissAppUpdate(notice) {
        if (notice === "launch") service.dismissLaunchNotice();
        else void service.dismissAvailable();
      },
      installAppUpdate() {
        if (service.prepareInstall()) input.quit();
      },
    },
    start() {
      if (!input.packaged) return;
      void service.recordLaunch().catch(logStopped).finally(check);
      setInterval(check, APP_UPDATE_CHECK_INTERVAL_MS).unref();
    },
  };
}
