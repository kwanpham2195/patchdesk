import {
  access,
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
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

/**
 * The store keeps some files read-only (Insight evidence), and the copy keeps
 * that mode, which would leave the worktree app unable to prune them.
 *
 * @param {string} root
 */
async function makeWritable(root) {
  for (const relative of await readdir(root, { recursive: true })) {
    const path = join(root, relative);
    const info = await stat(path);
    await chmod(path, info.mode | (info.isDirectory() ? 0o700 : 0o600));
  }
}

/**
 * Seed a worktree's dev profile once: config and profiles from the installed
 * app (the `ghAccount` names stay, so GitHub access works), plus a snapshot of
 * the main dev app's data store so existing Reviews show. The data comes from
 * the dev store, not the installed one, because a dev build refuses to start on
 * Review files an older installed release wrote. It only reads the sources. Notifications start off, so the worktree app does no background
 * watching and shows no desktop notification. Logs and the MCP socket stay
 * behind. Does nothing when the profile already has a config.
 *
 * @param {{
 *   readonly homeDirectory: string;
 *   readonly configDirectory: string;
 *   readonly dataDirectory: string;
 *   readonly output: CommandOutput;
 * }} options
 * @returns {Promise<"seeded" | "existing" | "no-installed-profile">}
 */
export async function seedWorktreeProfile({
  homeDirectory,
  configDirectory,
  dataDirectory,
  output,
}) {
  if (await exists(join(configDirectory, "config.json"))) return "existing";
  const installedConfig = configDirectories(homeDirectory).installed;
  const developmentData = join(
    homeDirectory,
    ".local",
    "share",
    "patchdesk-dev",
  );
  if (!(await exists(join(installedConfig, "config.json"))))
    return "no-installed-profile";

  // An interrupted earlier seed leaves read-only evidence files that block copying over them.
  if (await exists(dataDirectory)) {
    await makeWritable(dataDirectory);
    await rm(dataDirectory, { recursive: true, force: true });
  }
  await rm(join(configDirectory, "profiles"), { recursive: true, force: true });
  await mkdir(configDirectory, { recursive: true });
  if (await exists(join(installedConfig, "profiles")))
    await cp(
      join(installedConfig, "profiles"),
      join(configDirectory, "profiles"),
      { recursive: true },
    );
  await mkdir(dataDirectory, { recursive: true });
  if (await exists(developmentData))
    for (const entry of await readdir(developmentData))
      if (entry !== "logs" && entry !== "mcp")
        await cp(join(developmentData, entry), join(dataDirectory, entry), {
          recursive: true,
          // Clones on APFS, so a store of a gigabyte copies in seconds; elsewhere it copies.
          mode: constants.COPYFILE_FICLONE,
        });
  await makeWritable(dataDirectory);
  // Written last: its presence marks a complete seed, so an interrupted copy retries.
  const config = JSON.parse(
    await readFile(join(installedConfig, "config.json"), "utf8"),
  );
  await writeFile(
    join(configDirectory, "config.json"),
    `${JSON.stringify({ ...config, notifications: { ...config.notifications, enabled: false } })}\n`,
  );
  output.stdout(
    `dev: seeded ${configDirectory} from the installed profile, notifications off\n`,
  );
  return "seeded";
}
