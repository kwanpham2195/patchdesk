import { isAbsolute, join, resolve } from "node:path";

import {
  describeCause,
  execute,
  hasExit,
  replay,
} from "./gate-command-lib.mjs";
import { packagedMacAppBundlePath } from "./package-mac-lib.mjs";

/**
 * @typedef {import("./gate-command-lib.mjs").CommandOutput} CommandOutput
 */

/**
 * @typedef {import("./gate-command-lib.mjs").CommandResult} CommandResult
 */

/**
 * @typedef {import("./gate-command-lib.mjs").RunCommand} RunCommand
 */

/**
 * @typedef {{
 *   readonly exists: (path: string) => Promise<boolean>;
 *   readonly rename: (from: string, to: string) => Promise<void>;
 *   readonly remove: (path: string) => Promise<void>;
 * }} InstallFileSystem
 */

/**
 * @typedef {{
 *   readonly projectRoot: string;
 *   readonly run: RunCommand;
 *   readonly output: CommandOutput;
 * }} CommandContext
 */

/**
 * @typedef {{
 *   readonly destination: string;
 *   readonly staging: string;
 *   readonly backup: string;
 * }} InstallPaths
 */

/**
 * @typedef {{
 *   readonly args: ReadonlyArray<string>;
 *   readonly projectRoot: string;
 *   readonly arch: string;
 *   readonly environment: Readonly<Record<string, string | undefined>>;
 *   readonly run: RunCommand;
 *   readonly output: CommandOutput;
 *   readonly fileSystem: InstallFileSystem;
 *   readonly sleep: (milliseconds: number) => Promise<void>;
 * }} InstallOptions
 */

const DEFAULT_INSTALL_DIR = "/Applications";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const QUIT_POLL_INTERVAL_MS = 500;
const QUIT_POLL_ATTEMPTS = 40;

/** A failure whose message is already written for the person running the install. */
class InstallFailure extends Error {}

/**
 * Install the app `pnpm package:mac` built into `/Applications` (or
 * `PATCHDESK_INSTALL_DIR`), replacing any copy already there, and open it.
 *
 * @param {InstallOptions} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function installPackagedMacApp(options) {
  try {
    await install(options);
    return 0;
  } catch (cause) {
    if (!(cause instanceof InstallFailure)) throw cause;
    options.output.stderr(`${cause.message}\n`);
    return 1;
  }
}

/**
 * @param {InstallOptions} options
 * @returns {Promise<void>}
 */
async function install({
  args,
  projectRoot,
  arch,
  environment,
  run,
  output,
  fileSystem,
  sleep,
}) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--no-open"))
    throw new InstallFailure(
      "install:mac: usage: node scripts/install-mac.mjs [--no-open]",
    );

  const source = packagedMacAppBundlePath(join(projectRoot, "release"), arch);
  if (!(await fileSystem.exists(source)))
    throw new InstallFailure(
      `install:mac: there is no packaged app at ${source}. Run pnpm package:mac first, or pnpm install:mac to build and install in one step.`,
    );

  const configuredDir = environment.PATCHDESK_INSTALL_DIR;
  const installDir =
    configuredDir === undefined || configuredDir === ""
      ? DEFAULT_INSTALL_DIR
      : configuredDir;
  if (!isAbsolute(installDir))
    throw new InstallFailure(
      `install:mac: PATCHDESK_INSTALL_DIR must be an absolute path, got ${installDir}.`,
    );
  // `resolve` drops a trailing slash so the executable path matches what `ps` reports.
  const directory = resolve(installDir);
  if (!(await fileSystem.exists(directory)))
    throw new InstallFailure(
      `install:mac: the install folder ${directory} does not exist.`,
    );
  const paths = {
    destination: join(directory, "Patchdesk.app"),
    staging: join(directory, ".Patchdesk.app.installing"),
    backup: join(directory, ".Patchdesk.app.previous"),
  };
  // Checked before quitting the app: a backup left by a failed run may be the only copy of the previous app.
  if (await fileSystem.exists(paths.backup))
    throw new InstallFailure(
      `install:mac: ${paths.backup} is left over from an earlier failed install. Move it back to ${paths.destination} or delete it, then run again.`,
    );
  const context = { projectRoot, run, output };

  await quitInstalledCopy(paths.destination, context, sleep);
  await replaceInstalledApp(source, paths, context, fileSystem);
  await runChecked(
    context,
    LSREGISTER,
    ["-f", paths.destination],
    `install:mac: lsregister could not register ${paths.destination} with Launch Services.`,
  );
  const version = await runChecked(
    context,
    "plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      join(paths.destination, "Contents", "Info.plist"),
    ],
    `install:mac: plutil could not read the installed version from ${paths.destination}.`,
  );
  output.stdout(
    `install:mac: installed Patchdesk ${version.stdout.trim()} at ${paths.destination}.\n`,
  );
  if (args.length === 0)
    await runChecked(
      context,
      "open",
      [paths.destination],
      `install:mac: open could not launch ${paths.destination}.`,
    );
}

/**
 * Ask a Patchdesk running from `destination` to quit and wait for it to exit.
 *
 * @param {string} destination
 * @param {CommandContext} context
 * @param {(milliseconds: number) => Promise<void>} sleep
 * @returns {Promise<void>}
 */
async function quitInstalledCopy(destination, context, sleep) {
  const executable = join(destination, "Contents", "MacOS", "Patchdesk");
  if (!(await isRunningFrom(executable, context))) return;

  context.output.stdout(
    `install:mac: asking the Patchdesk running from ${destination} to quit.\n`,
  );
  // The path goes in as an argument so AppleScript never parses it as source.
  await runChecked(
    context,
    "osascript",
    [
      "-e",
      "on run argv",
      "-e",
      "tell application (item 1 of argv) to quit",
      "-e",
      "end run",
      destination,
    ],
    "install:mac: osascript could not ask Patchdesk to quit; quit it and run again.",
  );
  for (let attempt = 0; attempt < QUIT_POLL_ATTEMPTS; attempt += 1) {
    await sleep(QUIT_POLL_INTERVAL_MS);
    if (!(await isRunningFrom(executable, context))) return;
  }
  throw new InstallFailure(
    "install:mac: Patchdesk is still running; quit it and run again.",
  );
}

/**
 * Whether a Patchdesk main process runs from `executable`, so copies started
 * from any other path are ignored.
 *
 * @param {string} executable
 * @param {CommandContext} context
 * @returns {Promise<boolean>}
 */
async function isRunningFrom(executable, { projectRoot, run, output }) {
  const listed = await execute(
    run,
    "pgrep",
    ["-x", "Patchdesk"],
    projectRoot,
    output,
  );
  // pgrep exits 1 when no process matches.
  if (listed !== undefined && hasExit(listed, 1)) return false;
  if (listed === undefined || !hasExit(listed, 0)) {
    if (listed !== undefined) replay(listed, output);
    throw new InstallFailure(
      "install:mac: pgrep could not list the running Patchdesk processes.",
    );
  }

  const pids = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
  for (const pid of pids) {
    const described = await execute(
      run,
      "ps",
      ["-o", "command=", "-p", pid],
      projectRoot,
      output,
    );
    if (described === undefined)
      throw new InstallFailure(
        "install:mac: ps could not read the command line of a running Patchdesk.",
      );
    // ps exits 1 with no row when the process ended after pgrep listed it.
    if (!hasExit(described, 0)) continue;
    const command = described.stdout.trim();
    if (command === executable || command.startsWith(`${executable} `))
      return true;
  }
  return false;
}

/**
 * Copy the packaged app into a sibling of the destination, then swap it in by
 * rename, so a failed copy never leaves the installed app half-replaced.
 *
 * @param {string} source
 * @param {InstallPaths} paths
 * @param {CommandContext} context
 * @param {InstallFileSystem} fileSystem
 * @returns {Promise<void>}
 */
async function replaceInstalledApp(
  source,
  { destination, staging, backup },
  context,
  fileSystem,
) {
  await fileSystem.remove(staging);
  context.output.stdout(`install:mac: copying ${source} to ${destination}.\n`);
  try {
    await runChecked(
      context,
      "ditto",
      [source, staging],
      `install:mac: ditto could not copy ${source} to ${staging}.`,
    );
    if (!(await fileSystem.exists(destination))) {
      await renameOrFail(
        fileSystem,
        staging,
        destination,
        `install:mac: could not move the new app into ${destination}`,
      );
      return;
    }
    await renameOrFail(
      fileSystem,
      destination,
      backup,
      `install:mac: could not move the existing ${destination} aside`,
    );
    try {
      await fileSystem.rename(staging, destination);
    } catch (cause) {
      await renameOrFail(
        fileSystem,
        backup,
        destination,
        `install:mac: could not move the new app into ${destination} (${describeCause(cause)}), and could not restore the previous app from ${backup}; move it back by hand`,
      );
      throw new InstallFailure(
        `install:mac: could not move the new app into ${destination}, so the previous app was put back: ${describeCause(cause)}.`,
      );
    }
    await fileSystem.remove(backup);
  } finally {
    await fileSystem.remove(staging);
  }
}

/**
 * @param {InstallFileSystem} fileSystem
 * @param {string} from
 * @param {string} to
 * @param {string} failure
 * @returns {Promise<void>}
 */
async function renameOrFail(fileSystem, from, to, failure) {
  try {
    await fileSystem.rename(from, to);
  } catch (cause) {
    throw new InstallFailure(`${failure}: ${describeCause(cause)}.`);
  }
}

/**
 * Run a command that must succeed, replaying its output when it does not.
 *
 * @param {CommandContext} context
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {string} failure
 * @returns {Promise<CommandResult>}
 */
async function runChecked(
  { projectRoot, run, output },
  command,
  args,
  failure,
) {
  const result = await execute(run, command, args, projectRoot, output);
  if (result !== undefined && hasExit(result, 0)) return result;
  if (result !== undefined) replay(result, output);
  throw new InstallFailure(failure);
}
