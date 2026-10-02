import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { INSTALLED_APP_PATH } from "../../domain/app-update";

/** The Homebrew prefixes Patchdesk recognizes; nothing else is searched, so no release data can choose an executable. */
const homebrewPrefixes = ["/opt/homebrew", "/usr/local"] as const;

/**
 * Waits for the app to quit, refreshes the taps, upgrades the cask, clears
 * quarantine and reopens the installed app, writing everything to the log.
 * Every input arrives as a positional parameter (`$1`…`$7`), so no value is
 * ever interpolated into the script. `brew upgrade` alone refreshes taps only
 * once a day and never with `HOMEBREW_NO_AUTO_UPDATE`, so `brew update` runs
 * first. The app reopens after a failed or empty upgrade too, so its next
 * launch can report it.
 */
const updateHelperScript = `pid=$1 log=$2 brew=$3 xattr=$4 open=$5 defaults=$6 app=$7
exec >"$log" 2>&1
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
echo "Patchdesk update: running brew update."
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
 * What a helper may run with. `brew` resets PATH and filters the rest itself,
 * so nothing else is passed, and none of the app's provider keys reach it.
 */
const helperEnvironmentNames = ["HOME", "USER", "LANG"] as const;

/** One of the two fixed `brew` paths `findHomebrewInstall` can answer. */
export type HomebrewBrewPath = `${(typeof homebrewPrefixes)[number]}/bin/brew`;

/**
 * The `brew` to upgrade with, when Patchdesk was installed through its cask:
 * a `Caskroom/patchdesk` entry under either prefix and `brew` under either.
 */
export function findHomebrewInstall(
  exists: (path: string) => boolean,
): HomebrewBrewPath | undefined {
  const caskInstalled = homebrewPrefixes.some((prefix) =>
    exists(`${prefix}/Caskroom/patchdesk`),
  );
  if (!caskInstalled) return undefined;
  return homebrewPrefixes
    .map((prefix): HomebrewBrewPath => `${prefix}/bin/brew`)
    .find((brewPath) => exists(brewPath));
}

/** The update helper as an executable and argument array; nothing goes through a shell string. */
type HomebrewUpdateHelperCommand = {
  readonly file: "/bin/sh";
  readonly args: readonly string[];
  readonly logPath: string;
};

export function homebrewUpdateHelperCommand(input: {
  readonly brewPath: HomebrewBrewPath;
  readonly appPid: number;
  readonly logPath: string;
}): HomebrewUpdateHelperCommand {
  return {
    file: "/bin/sh",
    args: [
      "-c",
      updateHelperScript,
      "patchdesk-update",
      String(input.appPid),
      input.logPath,
      input.brewPath,
      "/usr/bin/xattr",
      "/usr/bin/open",
      "/usr/bin/defaults",
      INSTALLED_APP_PATH,
    ],
    logPath: input.logPath,
  };
}

/**
 * Creates the log's folder, then starts the helper in its own session so it
 * outlives the app, and resolves once the process exists; the caller exits
 * the app only after that.
 */
export async function startHomebrewUpdateHelper(
  command: HomebrewUpdateHelperCommand,
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
