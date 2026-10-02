/** `major.minor.patch` with an optional leading `v`; a prerelease or build suffix does not match. */
const releaseVersionPattern = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** The one app copy the in-app update upgrades, clears and reopens. */
export const INSTALLED_APP_PATH = "/Applications/Patchdesk.app";

/**
 * Who manages the copy in `INSTALLED_APP_PATH`, which decides the command
 * that updates it; `notInstalled` is a copy running elsewhere, such as from
 * the disk image, with nothing in `/Applications`.
 */
export type AppInstallSource = "homebrew" | "installer" | "notInstalled";

const INSTALLER_URL =
  "https://raw.githubusercontent.com/kwanpham2195/patchdesk/main/scripts/install-release.sh";

/** What the title bar tells the maintainer to run by hand, and the line before it. */
type ManualAppUpdate = {
  readonly instruction: string;
  readonly command: string;
};

/** The installer's `--update` refuses while Patchdesk runs, so its instruction says to quit first. */
const manualAppUpdates = {
  homebrew: {
    instruction: "To update by hand, run this in Terminal:",
    // The in-app update runs the same two steps (#800).
    command:
      "brew upgrade --cask patchdesk && xattr -dr com.apple.quarantine /Applications/Patchdesk.app",
  },
  installer: {
    instruction: "Quit Patchdesk, then run this in Terminal:",
    command: `curl -fsSL ${INSTALLER_URL} | sh -s -- --update`,
  },
  notInstalled: {
    instruction: "To install Patchdesk in Applications, run this in Terminal:",
    command: `curl -fsSL ${INSTALLER_URL} | sh`,
  },
} as const satisfies Readonly<Record<AppInstallSource, ManualAppUpdate>>;

/** The manual update for an install from `source`. */
export function manualAppUpdate(source: AppInstallSource): ManualAppUpdate {
  return manualAppUpdates[source];
}

/**
 * The latest release's version without its `v`, when that tag is a stable
 * release newer than the running version. Prereleases and unparseable tags
 * answer `undefined`, so they are never offered.
 */
export function newerReleaseVersion(
  latestTag: string,
  runningVersion: string,
): string | undefined {
  const latest = releaseVersionParts(latestTag);
  const running = releaseVersionParts(runningVersion);
  if (latest === undefined || running === undefined) return undefined;
  for (const [index, part] of latest.entries()) {
    const current = running[index] ?? 0;
    if (part !== current) return part > current ? latest.join(".") : undefined;
  }
  return undefined;
}

function releaseVersionParts(version: string): readonly number[] | undefined {
  const match = releaseVersionPattern.exec(version);
  return match === null ? undefined : match.slice(1).map(Number);
}

/** A newer release the title bar offers until it is dismissed. */
export type AvailableAppUpdate = {
  readonly version: string;
  /** The release page on github.com, checked before it is offered. */
  readonly releaseUrl: string;
  readonly installedBy: AppInstallSource;
  /** True when Update now can run the update; otherwise the title bar offers `manualUpdateCommand(installedBy)` to copy. */
  readonly canInstall: boolean;
  /** True between Update now and the quit; the close guard can still cancel it. */
  readonly installing: boolean;
};

/** What the first launch after an update attempt reports, once. */
export type AppUpdateLaunchNotice =
  | { readonly kind: "updated"; readonly version: string }
  | {
      readonly kind: "updateFailed";
      readonly logPath: string;
      readonly installedBy: AppInstallSource;
    };

/** The update state the main process pushes to the title bar. */
export type AppUpdateState = {
  readonly available?: AvailableAppUpdate;
  readonly launchNotice?: AppUpdateLaunchNotice;
};
