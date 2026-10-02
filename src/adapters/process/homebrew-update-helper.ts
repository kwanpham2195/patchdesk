import { spawn } from "node:child_process";

/** The Homebrew prefixes Patchdesk recognizes; nothing else is searched, so no release data can choose an executable. */
const homebrewPrefixes = ["/opt/homebrew", "/usr/local"] as const;

const installedApp = "/Applications/Patchdesk.app";

/**
 * Waits for the app to quit, upgrades the cask, clears quarantine and reopens
 * the app, writing everything to the log. Every input arrives as a positional
 * parameter (`$1`…`$6`), so no value is ever interpolated into the script.
 * The app reopens after a failed upgrade too, so its next launch can report it.
 */
const updateHelperScript = `pid=$1 log=$2 brew=$3 xattr=$4 open=$5 app=$6
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
echo "Patchdesk update: running brew upgrade --cask patchdesk."
if "$brew" upgrade --cask patchdesk; then
  "$xattr" -dr com.apple.quarantine "$app" || echo "Patchdesk update: clearing the quarantine flag failed."
  echo "Patchdesk update: finished."
else
  echo "Patchdesk update: brew upgrade failed with exit code $?."
fi
"$open" -a Patchdesk
`;

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
      installedApp,
    ],
  };
}

/**
 * Starts the helper in its own session so it outlives the app, and resolves
 * once the process exists; the caller exits the app only after that.
 */
export async function startHomebrewUpdateHelper(
  command: HomebrewUpdateHelperCommand,
): Promise<void> {
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}
