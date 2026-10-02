import type {
  LatestReleaseFailure,
  PatchdeskRelease,
} from "../adapters/github/github-latest-release";
import type { HomebrewBrewPath } from "../adapters/process/homebrew-update-helper";
import type { AppUpdateRecord } from "../adapters/storage/app-update-state-store";
import {
  newerReleaseVersion,
  type AppUpdateLaunchNotice,
  type AvailableAppUpdate,
  type AppUpdateState,
} from "../domain/app-update";
import { definedProps } from "../domain/defined-props";
import type { Result } from "../domain/result";

type AppUpdateDependencies = {
  /** `app.getVersion()`. */
  readonly runningVersion: string;
  readonly store: {
    load(): Promise<AppUpdateRecord>;
    save(record: AppUpdateRecord): Promise<boolean>;
  };
  /** Settings → Check for updates, read before every check so Off sends nothing. */
  readonly checkEnabled: () => Promise<boolean>;
  readonly fetchLatestRelease: () => Promise<
    Result<PatchdeskRelease | undefined, LatestReleaseFailure>
  >;
  /** The cask's `brew`, or `undefined` when Patchdesk was not installed through Homebrew. */
  readonly homebrewBrewPath: HomebrewBrewPath | undefined;
  /** Where the helper writes; a failed update's notice names it. */
  readonly logPath: string;
  readonly startHelper: (brewPath: HomebrewBrewPath) => Promise<void>;
  /** Pushes every state change to the title bar. */
  readonly publish: (state: AppUpdateState) => void;
  /** Called for the first failed check of a launch only. */
  readonly warn: (failure: LatestReleaseFailure) => void;
};

/**
 * Owns the in-app update (#800): the release check, the title-bar state, the
 * dismissed release, and the install that runs only once the app is really
 * quitting. The close guard can still cancel that quit, and `cancelInstall`
 * is how it says so.
 */
export class AppUpdateService {
  private record: AppUpdateRecord = {};
  private available:
    | { readonly version: string; readonly releaseUrl: string }
    | undefined;
  private launchNotice: AppUpdateLaunchNotice | undefined;
  private installing = false;
  private warned = false;

  constructor(private readonly dependencies: AppUpdateDependencies) {}

  /**
   * Reports the outcome of the previous launch's update, once: a changed
   * version is "Updated to", an attempt that left it unchanged failed.
   */
  async recordLaunch(): Promise<void> {
    const { runningVersion } = this.dependencies;
    const record = await this.dependencies.store.load();
    this.launchNotice =
      record.lastLaunchedVersion !== undefined &&
      record.lastLaunchedVersion !== runningVersion
        ? { kind: "updated", version: runningVersion }
        : record.updateAttemptedFrom === runningVersion
          ? { kind: "updateFailed", logPath: this.dependencies.logPath }
          : undefined;
    const { updateAttemptedFrom: _consumed, ...kept } = record;
    this.record = { ...kept, lastLaunchedVersion: runningVersion };
    await this.dependencies.store.save(this.record);
    this.publish();
  }

  async check(): Promise<void> {
    if (!(await this.dependencies.checkEnabled())) return;
    const latest = await this.dependencies.fetchLatestRelease();
    if (latest._tag === "err") {
      if (!this.warned) this.dependencies.warn(latest.error);
      this.warned = true;
      return;
    }
    if (this.installing) return;
    const version =
      latest.value === undefined
        ? undefined
        : newerReleaseVersion(
            latest.value.tagName,
            this.dependencies.runningVersion,
          );
    const next =
      version === undefined ||
      latest.value === undefined ||
      version === this.record.dismissedVersion
        ? undefined
        : { version, releaseUrl: latest.value.releaseUrl };
    if (next?.version === this.available?.version) return;
    this.available = next;
    this.publish();
  }

  state(): AppUpdateState {
    const install: AvailableAppUpdate["install"] =
      this.dependencies.homebrewBrewPath === undefined ? "manual" : "homebrew";
    return definedProps({
      available:
        this.available === undefined
          ? undefined
          : { ...this.available, install, installing: this.installing },
      launchNotice: this.launchNotice,
    });
  }

  /** Hides the offered release, and only that one, across launches. */
  async dismissAvailable(): Promise<void> {
    if (this.available === undefined || this.installing) return;
    this.record = { ...this.record, dismissedVersion: this.available.version };
    this.available = undefined;
    this.publish();
    await this.dependencies.store.save(this.record);
  }

  dismissLaunchNotice(): void {
    this.launchNotice = undefined;
    this.publish();
  }

  /** Marks an install to run when the app quits; the caller then asks to quit. */
  prepareInstall(): boolean {
    if (
      this.available === undefined ||
      this.dependencies.homebrewBrewPath === undefined
    )
      return false;
    this.installing = true;
    this.publish();
    return true;
  }

  /** The close guard kept the app open, so the install must not run. */
  cancelInstall(): void {
    if (!this.installing) return;
    this.installing = false;
    this.publish();
  }

  /**
   * Called on the way out, after the close guard: records the attempt for the
   * next launch, then starts the helper, which waits for this process to exit.
   */
  async startInstallBeforeExit(): Promise<void> {
    const brewPath = this.dependencies.homebrewBrewPath;
    if (!this.installing || brewPath === undefined) return;
    this.installing = false;
    this.record = {
      ...this.record,
      updateAttemptedFrom: this.dependencies.runningVersion,
    };
    await this.dependencies.store.save(this.record);
    await this.dependencies.startHelper(brewPath);
  }

  private publish(): void {
    this.dependencies.publish(this.state());
  }
}
