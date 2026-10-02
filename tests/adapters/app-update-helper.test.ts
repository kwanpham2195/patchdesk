import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appUpdateHelperCommand,
  findAppInstallation,
  startAppUpdateHelper,
  type AppInstallation,
  type AppUpdater,
} from "../../src/adapters/process/app-update-helper";

const installerPath =
  "/Applications/Patchdesk.app/Contents/Resources/install-release.sh";

describe("findAppInstallation", () => {
  it.each<{
    readonly name: string;
    readonly present: readonly string[];
    readonly writable: readonly string[];
    readonly want: AppInstallation;
  }>([
    {
      name: "an Apple Silicon cask install",
      present: ["/opt/homebrew/Caskroom/patchdesk", "/opt/homebrew/bin/brew"],
      writable: [],
      want: {
        installedBy: "homebrew",
        updater: { kind: "homebrew", brewPath: "/opt/homebrew/bin/brew" },
      },
    },
    {
      name: "an Intel-prefix cask install",
      present: ["/usr/local/Caskroom/patchdesk", "/usr/local/bin/brew"],
      writable: [],
      want: {
        installedBy: "homebrew",
        updater: { kind: "homebrew", brewPath: "/usr/local/bin/brew" },
      },
    },
    {
      name: "a Caskroom entry without brew",
      present: ["/opt/homebrew/Caskroom/patchdesk"],
      writable: ["/Applications", "/Applications/Patchdesk.app"],
      want: { installedBy: "homebrew", updater: undefined },
    },
    {
      name: "a writable install brew does not manage",
      present: ["/opt/homebrew/bin/brew", "/Applications/Patchdesk.app"],
      writable: ["/Applications", "/Applications/Patchdesk.app"],
      want: {
        installedBy: "installer",
        updater: { kind: "installer", installerPath },
      },
    },
    {
      name: "an Applications folder only an administrator can write",
      present: ["/Applications/Patchdesk.app"],
      writable: ["/Applications/Patchdesk.app"],
      want: { installedBy: "installer", updater: undefined },
    },
    {
      name: "an app only an administrator can replace",
      present: ["/Applications/Patchdesk.app"],
      writable: ["/Applications"],
      want: { installedBy: "installer", updater: undefined },
    },
    {
      name: "a copy running elsewhere with nothing in /Applications",
      present: ["/opt/homebrew/bin/brew"],
      writable: ["/Applications"],
      want: { installedBy: "notInstalled", updater: undefined },
    },
  ])("answers $name", ({ present, writable, want }) => {
    expect(
      findAppInstallation({
        exists: (path) => present.includes(path),
        writable: (path) => writable.includes(path),
        installerPath,
      }),
    ).toEqual(want);
  });
});

describe("appUpdateHelperCommand", () => {
  it("runs a fixed /bin/sh script whose only inputs are the PID, the log path and fixed paths", () => {
    const first = appUpdateHelperCommand({
      updater: { kind: "homebrew", brewPath: "/opt/homebrew/bin/brew" },
      appPid: 4242,
      logPath: "/Users/someone/.local/share/patchdesk/logs/update.log",
    });
    const second = appUpdateHelperCommand({
      updater: { kind: "homebrew", brewPath: "/usr/local/bin/brew" },
      appPid: 7,
      logPath: "/tmp/other.log",
    });

    expect(first.file).toBe("/bin/sh");
    expect(first.args[0]).toBe("-c");
    // The script text never varies with its inputs: nothing is interpolated into it.
    expect(second.args[1]).toBe(first.args[1]);
    expect(first.args.slice(2)).toEqual([
      "patchdesk-update",
      "4242",
      "/Users/someone/.local/share/patchdesk/logs/update.log",
      "/opt/homebrew/bin/brew",
      "/usr/bin/xattr",
      "/usr/bin/open",
      "/usr/bin/defaults",
      "/Applications/Patchdesk.app",
    ]);
  });
});

describe("the update helper", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-update-helper-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A stand-in executable that records its name, its arguments, whether the app still ran, and whether a provider key reached it. */
  async function fake(name: string, appPid: number, body: string) {
    const path = join(root, name);
    await writeFile(
      path,
      `#!/bin/sh\nif kill -0 ${appPid} 2>/dev/null; then state=running; else state=gone; fi\necho "${name} $* app=$state key=\${OPENAI_API_KEY:-unset}" >> "${join(root, "calls")}"\n${body}\n`,
    );
    await chmod(path, 0o755);
    return path;
  }

  /**
   * Starts the helper for `updater` against a short-lived stand-in app, with
   * each fixed executable replaced by a recording fake whose body may write a
   * new version to `$version_file`, then waits for the reopen.
   */
  async function runHelper(
    updater: AppUpdater,
    bodies: Readonly<Record<string, string>>,
  ) {
    const app = spawn("/bin/sleep", ["0.5"]);
    const appPid = app.pid ?? 0;
    const version = join(root, "version");
    await writeFile(version, "0.0.17\n");
    // The logs folder does not exist yet; the helper must create it.
    const logPath = join(root, "missing", "logs", "update.log");
    const command = appUpdateHelperCommand({ updater, appPid, logPath });
    const fakes = new Map<string, string>();
    for (const [path, body] of Object.entries(bodies))
      fakes.set(
        path,
        await fake(
          basename(path),
          appPid,
          `version_file="${version}"\n${body}`,
        ),
      );
    fakes.set("/usr/bin/open", await fake("open", appPid, "exit 0"));
    fakes.set("/usr/bin/defaults", join(root, "defaults"));
    await writeFile(join(root, "defaults"), `#!/bin/sh\ncat "${version}"\n`);
    await chmod(join(root, "defaults"), 0o755);

    await startAppUpdateHelper(
      { ...command, args: command.args.map((arg) => fakes.get(arg) ?? arg) },
      { HOME: root, OPENAI_API_KEY: "sk-secret" },
    );
    const calls = await waitForReopen(join(root, "calls"));
    return { calls, log: await readFile(logPath, "utf8") };
  }

  function runBrewHelper(brew: {
    readonly updateExit: number;
    readonly upgradeExit: number;
    readonly upgradeInstalls: boolean;
  }) {
    return runHelper(
      { kind: "homebrew", brewPath: "/opt/homebrew/bin/brew" },
      {
        "/opt/homebrew/bin/brew": `if [ "$1" = update ]; then exit ${brew.updateExit}; fi\n${brew.upgradeInstalls ? 'echo 0.0.18 > "$version_file"\n' : ""}exit ${brew.upgradeExit}`,
        "/usr/bin/xattr": "exit 0",
      },
    );
  }

  /** The bundled installer stand-in also records the path it ran from, so the test can see it ran from a copy. */
  function runInstallerHelper(installer: {
    readonly exit: number;
    readonly installs: boolean;
  }) {
    return runHelper(
      { kind: "installer", installerPath: "/bundle/install-release.sh" },
      {
        "/bundle/install-release.sh": `echo "$0" > "${join(root, "ran-from")}"\n${installer.installs ? 'echo 0.0.18 > "$version_file"\n' : ""}exit ${installer.exit}`,
      },
    );
  }

  it("waits for the app to quit, refreshes taps, upgrades, clears quarantine and reopens the installed app", async () => {
    const { calls, log } = await runBrewHelper({
      updateExit: 0,
      upgradeExit: 0,
      upgradeInstalls: true,
    });

    expect(calls).toEqual([
      "brew update --quiet app=gone key=unset",
      "brew upgrade --cask patchdesk app=gone key=unset",
      "xattr -dr com.apple.quarantine /Applications/Patchdesk.app app=gone key=unset",
      "open /Applications/Patchdesk.app app=gone key=unset",
    ]);
    expect(log).toContain("finished, 0.0.17 to 0.0.18");
  });

  it("still upgrades after a failed brew update, and says so when the upgrade changed nothing", async () => {
    const { calls, log } = await runBrewHelper({
      updateExit: 1,
      upgradeExit: 0,
      upgradeInstalls: false,
    });

    expect(calls).toEqual([
      "brew update --quiet app=gone key=unset",
      "brew upgrade --cask patchdesk app=gone key=unset",
      "open /Applications/Patchdesk.app app=gone key=unset",
    ]);
    expect(log).toContain("brew update failed with exit code 1");
    expect(log).toContain("brew upgraded nothing");
    expect(log).not.toContain("finished");
  });

  it("reopens the app without clearing quarantine and logs the exit code when brew upgrade fails", async () => {
    const { calls, log } = await runBrewHelper({
      updateExit: 0,
      upgradeExit: 3,
      upgradeInstalls: false,
    });

    expect(calls).toEqual([
      "brew update --quiet app=gone key=unset",
      "brew upgrade --cask patchdesk app=gone key=unset",
      "open /Applications/Patchdesk.app app=gone key=unset",
    ]);
    expect(log).toContain("exit code 3");
  });

  it("waits for the app to quit, runs a copy of the bundled installer with --update, removes the copy and reopens the app", async () => {
    const { calls, log } = await runInstallerHelper({
      exit: 0,
      installs: true,
    });

    expect(calls).toEqual([
      "install-release.sh --update app=gone key=unset",
      "open /Applications/Patchdesk.app app=gone key=unset",
    ]);
    const ranFrom = (await readFile(join(root, "ran-from"), "utf8")).trim();
    expect(ranFrom).not.toBe(join(root, "install-release.sh"));
    expect(existsSync(ranFrom)).toBe(false);
    expect(log).toContain("finished, 0.0.17 to 0.0.18");
  });

  it("reopens the app and logs the exit code when the installer fails", async () => {
    const { calls, log } = await runInstallerHelper({
      exit: 4,
      installs: false,
    });

    expect(calls).toEqual([
      "install-release.sh --update app=gone key=unset",
      "open /Applications/Patchdesk.app app=gone key=unset",
    ]);
    expect(log).toContain("the installer failed with exit code 4");
  });
});

/** The helper is detached, so the test waits for its last step, the reopen. */
async function waitForReopen(callsPath: string): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const calls = await readFile(callsPath, "utf8").catch(() => "");
    const lines = calls.trim().split("\n");
    if (lines.some((line) => line.startsWith("open "))) return lines;
    if (Date.now() > deadline)
      throw new Error(`helper did not reopen: ${calls}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
