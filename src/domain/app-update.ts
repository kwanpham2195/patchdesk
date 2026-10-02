/** `major.minor.patch` with an optional leading `v`; a prerelease or build suffix does not match. */
const releaseVersionPattern = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** The one app copy the in-app update upgrades, clears and reopens. */
export const INSTALLED_APP_PATH = "/Applications/Patchdesk.app";

/** The command a Homebrew install runs by hand; the in-app update runs the same two steps (#800). */
export const MANUAL_UPDATE_COMMAND =
  "brew upgrade --cask patchdesk && xattr -dr com.apple.quarantine /Applications/Patchdesk.app";

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
  /** `homebrew` offers Update now; `manual` offers `MANUAL_UPDATE_COMMAND` to copy. */
  readonly install: "homebrew" | "manual";
  /** True between Update now and the quit; the close guard can still cancel it. */
  readonly installing: boolean;
};

/** What the first launch after an update attempt reports, once. */
export type AppUpdateLaunchNotice =
  | { readonly kind: "updated"; readonly version: string }
  | { readonly kind: "updateFailed"; readonly logPath: string };

/** The update state the main process pushes to the title bar. */
export type AppUpdateState = {
  readonly available?: AvailableAppUpdate;
  readonly launchNotice?: AppUpdateLaunchNotice;
};
