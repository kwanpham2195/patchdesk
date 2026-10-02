import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  INSTALLED_APP_PATH,
  type AppInstallSource,
} from "../../domain/app-update";

/** The Homebrew prefixes Patchdesk recognizes; nothing else is searched, so no release data can choose an executable. */
const homebrewPrefixes = ["/opt/homebrew", "/usr/local"] as const;

/** Both helpers wait for the app to quit first, because the update replaces the app bundle. */
const waitForAppToQuit = `exec >"$log" 2>&1
echo "Patchdesk update: waiting for process $pid to quit."
waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge 600 ]; then
    echo "Patchdesk update: Patchdesk did not quit within 2 minutes; nothing was upgraded."
    exit 1
  fi
  waited=$((waited + 1))
  /bin/sleep 0.2
done
before=$("$defaults" read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)
`;

/**
 * Waits for the app to quit, refreshes the taps, upgrades the cask, clears
 * quarantine and reopens the installed app, writing everything to the log.
 * Every input arrives as a positional parameter, so no value is ever
 * interpolated into the script. `brew upgrade` alone refreshes taps only
 * once a day and never with `HOMEBREW_NO_AUTO_UPDATE`, so `brew update` runs
 * first. The app reopens after a failed or empty upgrade too, so its next
 * launch can report it.
 */
const homebrewHelperScript = `pid=$1 log=$2 brew=$3 xattr=$4 open=$5 defaults=$6 app=$7
${waitForAppToQuit}echo "Patchdesk update: running brew update."
"$brew" update --quiet || echo "Patchdesk update: brew update failed with exit code $?; trying the upgrade anyway."
echo "Patchdesk update: running brew upgrade --cask patchdesk."
if "$brew" upgrade --cask patchdesk; then
  after=$("$defaults" read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)
  if [ "$after" = "$before" ]; then
    echo "Patchdesk update: brew upgraded nothing; Patchdesk is still $before."
  else
    "$xattr" -dr com.apple.quarantine "$app" || echo "Patchdesk update: clearing the quarantine flag failed."
    echo "Patchdesk update: finished, $before to $after."
  fi
else
  echo "Patchdesk update: brew upgrade failed with exit code $?."
fi
"$open" "$app"
`;

/**
 * The same lifecycle for an app Homebrew does not manage, through the release
 * installer bundled with the running version, so nothing is fetched from the
 * repository's main branch at update time. It runs from a copy so the
 * installer never reads from the bundle it replaces.
 */
const installerHelperScript = `pid=$1 log=$2 installer=$3 open=$4 defaults=$5 app=$6
${waitForAppToQuit}echo "Patchdesk update: running the release installer with --update."
if ! copy=$(/usr/bin/mktemp /tmp/patchdesk-install-release.XXXXXX) || ! /bin/cp "$installer" "$copy"; then
  echo "Patchdesk update: could not copy the installer from $installer; nothing was updated."
elif /bin/sh "$copy" --update; then
  after=$("$defaults" read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)
  if [ "$after" = "$before" ]; then
    echo "Patchdesk update: the installer changed nothing; Patchdesk is still $before."
  else
    echo "Patchdesk update: finished, $before to $after."
  fi
else
  echo "Patchdesk update: the installer failed with exit code $?."
fi
[ -z "\${copy:-}" ] || /bin/rm -f "$copy"
"$open" "$app"
`;

/** No provider key reaches a helper; `brew` resets PATH itself and the installer needs only system tools. */
const helperEnvironmentNames = ["HOME", "USER", "LANG"] as const;

/** One of the two fixed `brew` paths `findAppInstallation` can answer. */
type HomebrewBrewPath = `${(typeof homebrewPrefixes)[number]}/bin/brew`;

/** What Update now runs: the cask's `brew`, or the release installer bundled with the running app. */
export type AppUpdater =
  | { readonly kind: "homebrew"; readonly brewPath: HomebrewBrewPath }
  | { readonly kind: "installer"; readonly installerPath: string };

/** Who manages `INSTALLED_APP_PATH`, and what Update now runs, if anything. */
export type AppInstallation = {
  readonly installedBy: AppInstallSource;
  readonly updater: AppUpdater | undefined;
};

/** The installer path needs write access without `sudo`, because a detached helper cannot answer its prompt. */
export function findAppInstallation(input: {
  readonly exists: (path: string) => boolean;
  readonly writable: (path: string) => boolean;
  readonly installerPath: string;
}): AppInstallation {
  const caskInstalled = homebrewPrefixes.some((prefix) =>
    input.exists(`${prefix}/Caskroom/patchdesk`),
  );
  if (caskInstalled) {
    const brewPath = homebrewPrefixes
      .map((prefix): HomebrewBrewPath => `${prefix}/bin/brew`)
      .find((path) => input.exists(path));
    return {
      installedBy: "homebrew",
      updater:
        brewPath === undefined ? undefined : { kind: "homebrew", brewPath },
    };
  }
  if (!input.exists(INSTALLED_APP_PATH))
    return { installedBy: "notInstalled", updater: undefined };
  const replaceable =
    input.writable(dirname(INSTALLED_APP_PATH)) &&
    input.writable(INSTALLED_APP_PATH);
  return {
    installedBy: "installer",
    updater: replaceable
      ? { kind: "installer", installerPath: input.installerPath }
      : undefined,
  };
}

/** The update helper as an executable and argument array; nothing goes through a shell string. */
type AppUpdateHelperCommand = {
  readonly file: "/bin/sh";
  readonly args: readonly string[];
  readonly logPath: string;
};

export function appUpdateHelperCommand(input: {
  readonly updater: AppUpdater;
  readonly appPid: number;
  readonly logPath: string;
}): AppUpdateHelperCommand {
  const { updater } = input;
  const pid = String(input.appPid);
  const args =
    updater.kind === "homebrew"
      ? [
          "-c",
          homebrewHelperScript,
          "patchdesk-update",
          pid,
          input.logPath,
          updater.brewPath,
          "/usr/bin/xattr",
          "/usr/bin/open",
          "/usr/bin/defaults",
          INSTALLED_APP_PATH,
        ]
      : [
          "-c",
          installerHelperScript,
          "patchdesk-update",
          pid,
          input.logPath,
          updater.installerPath,
          "/usr/bin/open",
          "/usr/bin/defaults",
          INSTALLED_APP_PATH,
        ];
  return { file: "/bin/sh", args, logPath: input.logPath };
}

/**
 * Creates the log's folder, then starts the helper in its own session so it
 * outlives the app, and resolves once the process exists; the caller exits
 * the app only after that.
 */
export async function startAppUpdateHelper(
  command: AppUpdateHelperCommand,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await mkdir(dirname(command.logPath), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of helperEnvironmentNames)
    if (environment[name] !== undefined) env[name] = environment[name];
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    env,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}
