import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findHomebrewInstall,
  homebrewUpdateHelperCommand,
} from "../../src/adapters/process/homebrew-update-helper";

const run = promisify(execFile);

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
  it("runs a fixed /bin/sh script whose only inputs are the PID, the log path and fixed executables", () => {
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
      "/Applications/Patchdesk.app",
    ]);
  });
});

describe("the update helper script", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-update-helper-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A stand-in executable that records its name, its arguments and whether the app was still running. */
  async function recorder(name: string, exitCode: number): Promise<string> {
    const path = join(root, name);
    await writeFile(
      path,
      `#!/bin/sh\nif kill -0 "$APP_PID" 2>/dev/null; then state=running; else state=gone; fi\necho "${name} $* app=$state" >> "${join(root, "calls")}"\nexit ${exitCode}\n`,
    );
    await chmod(path, 0o755);
    return path;
  }

  async function runHelper(brewExitCode: number) {
    const app = spawn("/bin/sleep", ["0.5"]);
    const appPid = app.pid ?? 0;
    const logPath = join(root, "update.log");
    const command = homebrewUpdateHelperCommand({
      brewPath: "/opt/homebrew/bin/brew",
      appPid,
      logPath,
    });
    const fakes = new Map([
      ["/opt/homebrew/bin/brew", await recorder("brew", brewExitCode)],
      ["/usr/bin/xattr", await recorder("xattr", 0)],
      ["/usr/bin/open", await recorder("open", 0)],
    ]);
    await run(
      command.file,
      command.args.map((arg) => fakes.get(arg) ?? arg),
      { env: { ...process.env, APP_PID: String(appPid) } },
    );
    return {
      calls: (await readFile(join(root, "calls"), "utf8")).trim().split("\n"),
      log: await readFile(logPath, "utf8"),
    };
  }

  it("waits for the app to quit, then upgrades, clears quarantine and reopens", async () => {
    const { calls, log } = await runHelper(0);

    expect(calls).toEqual([
      "brew upgrade --cask patchdesk app=gone",
      "xattr -dr com.apple.quarantine /Applications/Patchdesk.app app=gone",
      "open -a Patchdesk app=gone",
    ]);
    expect(log).toContain("finished");
  });

  it("reopens the app without clearing quarantine and logs the exit code when brew fails", async () => {
    const { calls, log } = await runHelper(3);

    expect(calls).toEqual([
      "brew upgrade --cask patchdesk app=gone",
      "open -a Patchdesk app=gone",
    ]);
    expect(log).toContain("exit code 3");
  });
});
