import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findHomebrewInstall,
  homebrewUpdateHelperCommand,
  startHomebrewUpdateHelper,
} from "../../src/adapters/process/homebrew-update-helper";

describe("findHomebrewInstall", () => {
  it.each([
    {
      name: "an Apple Silicon cask install",
      present: ["/opt/homebrew/Caskroom/patchdesk", "/opt/homebrew/bin/brew"],
      want: "/opt/homebrew/bin/brew",
    },
    {
      name: "an Intel-prefix cask install",
      present: ["/usr/local/Caskroom/patchdesk", "/usr/local/bin/brew"],
      want: "/usr/local/bin/brew",
    },
    {
      name: "brew without the Patchdesk cask",
      present: ["/opt/homebrew/bin/brew"],
      want: undefined,
    },
    {
      name: "a Caskroom entry without brew",
      present: ["/opt/homebrew/Caskroom/patchdesk"],
      want: undefined,
    },
  ])("answers $name", ({ present, want }) => {
    expect(findHomebrewInstall((path) => present.includes(path))).toBe(want);
  });
});

describe("homebrewUpdateHelperCommand", () => {
  it("runs a fixed /bin/sh script whose only inputs are the PID, the log path and fixed paths", () => {
    const first = homebrewUpdateHelperCommand({
      brewPath: "/opt/homebrew/bin/brew",
      appPid: 4242,
      logPath: "/Users/someone/.local/share/patchdesk/logs/update.log",
    });
    const second = homebrewUpdateHelperCommand({
      brewPath: "/usr/local/bin/brew",
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

  async function runHelper(brew: {
    readonly updateExit: number;
    readonly upgradeExit: number;
    readonly upgradeInstalls: boolean;
  }) {
    const app = spawn("/bin/sleep", ["0.5"]);
    const appPid = app.pid ?? 0;
    const version = join(root, "version");
    await writeFile(version, "0.0.17\n");
    // The logs folder does not exist yet; the helper must create it.
    const logPath = join(root, "missing", "logs", "update.log");
    const command = homebrewUpdateHelperCommand({
      brewPath: "/opt/homebrew/bin/brew",
      appPid,
      logPath,
    });
    const brewBody = `if [ "$1" = update ]; then exit ${brew.updateExit}; fi\n${brew.upgradeInstalls ? `echo 0.0.18 > "${version}"\n` : ""}exit ${brew.upgradeExit}`;
    const fakes = new Map([
      ["/opt/homebrew/bin/brew", await fake("brew", appPid, brewBody)],
      ["/usr/bin/xattr", await fake("xattr", appPid, "exit 0")],
      ["/usr/bin/open", await fake("open", appPid, "exit 0")],
      ["/usr/bin/defaults", join(root, "defaults")],
    ]);
    await writeFile(join(root, "defaults"), `#!/bin/sh\ncat "${version}"\n`);
    await chmod(join(root, "defaults"), 0o755);

    await startHomebrewUpdateHelper(
      { ...command, args: command.args.map((arg) => fakes.get(arg) ?? arg) },
      { HOME: root, OPENAI_API_KEY: "sk-secret" },
    );
    const calls = await waitForReopen(join(root, "calls"));
    return { calls, log: await readFile(logPath, "utf8") };
  }

  it("waits for the app to quit, refreshes taps, upgrades, clears quarantine and reopens the installed app", async () => {
    const { calls, log } = await runHelper({
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
    const { calls, log } = await runHelper({
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
    const { calls, log } = await runHelper({
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
