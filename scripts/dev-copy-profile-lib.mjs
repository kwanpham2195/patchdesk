import { access, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * @typedef {import("./gate-command-lib.mjs").CommandOutput} CommandOutput
 */

/**
 * @typedef {{
 *   readonly args: ReadonlyArray<string>;
 *   readonly homeDirectory: string;
 *   readonly output: CommandOutput;
 * }} CopyProfileOptions
 */

const USAGE =
  "dev:copy-profile: usage: node scripts/dev-copy-profile.mjs [--force]";

/**
 * The config directories `PatchdeskPaths.forBuild` gives the installed app and an unpackaged build.
 *
 * @param {string} homeDirectory
 */
function configDirectories(homeDirectory) {
  return {
    installed: join(homeDirectory, ".config", "patchdesk"),
    development: join(homeDirectory, ".config", "patchdesk-dev"),
  };
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy `config.json` and the `profiles` directory from the installed app's
 * config directory into the dev app's, so `pnpm dev` starts with the same
 * workspaces and watchlists. Data and cache stay behind. Refuses to replace an
 * existing dev config unless `--force` is given.
 *
 * @param {CopyProfileOptions} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function copyInstalledProfileToDev({
  args,
  homeDirectory,
  output,
}) {
  if (args.some((arg) => arg !== "--force")) {
    output.stderr(`${USAGE}\n`);
    return 2;
  }
  const force = args.includes("--force");
  const { installed, development } = configDirectories(homeDirectory);

  if (!(await exists(join(installed, "config.json")))) {
    output.stderr(
      `dev:copy-profile: there is no config at ${join(installed, "config.json")}. Run the installed Patchdesk once first.\n`,
    );
    return 1;
  }
  if (!force && (await exists(join(development, "config.json")))) {
    output.stderr(
      `dev:copy-profile: ${join(development, "config.json")} already exists. Pass --force to replace it and the profiles.\n`,
    );
    return 1;
  }

  await mkdir(development, { recursive: true });
  // --force replaces the dev profiles outright, so a profile only the dev app had does not linger.
  await rm(join(development, "profiles"), { recursive: true, force: true });
  await cp(join(installed, "config.json"), join(development, "config.json"));
  if (await exists(join(installed, "profiles")))
    await cp(join(installed, "profiles"), join(development, "profiles"), {
      recursive: true,
    });
  output.stdout(
    `dev:copy-profile: copied config and profiles to ${development}\n`,
  );
  return 0;
}
