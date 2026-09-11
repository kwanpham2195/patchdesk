import { describe, expect, it } from "vitest";

import { installPackagedMacApp } from "../../scripts/install-mac-lib.mjs";

const SOURCE = "/repo/release/mac-arm64/Patchdesk.app";
const DESTINATION = "/Applications/Patchdesk.app";
const STAGING = "/Applications/.Patchdesk.app.installing";
const INSTALLED_EXECUTABLE = `${DESTINATION}/Contents/MacOS/Patchdesk`;
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

type CommandResult = {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

type Invocation = { command: string; args: ReadonlyArray<string> };

function exit(status: number, stdout = ""): CommandResult {
  return { status, signal: null, stdout, stderr: "" };
}

/**
 * Fakes the commands and the file system; `files` maps each app bundle path to
 * a label for which build it holds, so a test can see what ended up where.
 */
function harness({
  files = { "/Applications": "folder", [SOURCE]: "new build" },
  environment = {},
  pgrep = () => exit(1),
  commandLines = { "4242": INSTALLED_EXECUTABLE },
  failRenameFrom,
}: {
  files?: Record<string, string>;
  environment?: Record<string, string>;
  pgrep?: () => CommandResult;
  commandLines?: Record<string, string>;
  failRenameFrom?: string;
} = {}) {
  const tree = new Map(Object.entries(files));
  const invocations: Invocation[] = [];
  const sleeps: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = async (command: string, args: ReadonlyArray<string>) => {
    invocations.push({ command, args });
    if (command === "pgrep") return pgrep();
    if (command === "ps") {
      const line = commandLines[args.at(-1) ?? ""];
      return line === undefined ? exit(1) : exit(0, `${line}\n`);
    }
    if (command === "ditto") {
      const [from = "", to = ""] = args;
      tree.set(to, tree.get(from) ?? "");
    }
    if (command === "plutil") return exit(0, "0.0.8\n");
    return exit(0);
  };
  const fileSystem = {
    exists: async (path: string) => tree.has(path),
    rename: async (from: string, to: string) => {
      const contents = tree.get(from);
      if (contents === undefined || tree.has(to) || from === failRenameFrom)
        throw new Error(`EPERM: rename ${from} -> ${to}`);
      tree.delete(from);
      tree.set(to, contents);
    },
    remove: async (path: string) => {
      tree.delete(path);
    },
  };
  return {
    tree,
    invocations,
    sleeps,
    stdout,
    stderr,
    install: (args: ReadonlyArray<string> = []) =>
      installPackagedMacApp({
        args,
        projectRoot: "/repo",
        arch: "arm64",
        environment,
        run,
        output: {
          stdout: (text: string) => stdout.push(text),
          stderr: (text: string) => stderr.push(text),
        },
        fileSystem,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
        },
      }),
  };
}

function commandsRun(invocations: ReadonlyArray<Invocation>) {
  return invocations.map(({ command }) => command);
}

describe("installPackagedMacApp", () => {
  it("copies the packaged app into /Applications, registers it, and opens it", async () => {
    const { install, invocations, tree, stdout } = harness();

    expect(await install()).toBe(0);

    expect(invocations).toContainEqual({
      command: "ditto",
      args: [SOURCE, STAGING],
    });
    expect(invocations).toContainEqual({
      command: LSREGISTER,
      args: ["-f", DESTINATION],
    });
    expect(invocations.at(-1)).toEqual({
      command: "open",
      args: [DESTINATION],
    });
    expect(tree.get(DESTINATION)).toBe("new build");
    expect([...tree.keys()].sort()).toEqual(
      ["/Applications", DESTINATION, SOURCE].sort(),
    );
    expect(stdout.join("")).toContain(`Patchdesk 0.0.8 at ${DESTINATION}`);
  });

  it("replaces an existing install and leaves no staging or backup copy behind", async () => {
    const { install, tree } = harness({
      files: {
        "/Applications": "folder",
        [SOURCE]: "new build",
        [DESTINATION]: "Homebrew 0.0.7",
      },
    });

    expect(await install()).toBe(0);

    expect(tree.get(DESTINATION)).toBe("new build");
    expect([...tree.keys()].sort()).toEqual(
      ["/Applications", DESTINATION, SOURCE].sort(),
    );
  });

  it("puts the previous app back when the new one cannot be moved into place", async () => {
    const { install, tree, stderr, invocations } = harness({
      files: {
        "/Applications": "folder",
        [SOURCE]: "new build",
        [DESTINATION]: "Homebrew 0.0.7",
      },
      failRenameFrom: STAGING,
    });

    expect(await install()).toBe(1);

    expect(stderr.join("")).toContain("previous app was put back");
    expect(tree.get(DESTINATION)).toBe("Homebrew 0.0.7");
    expect([...tree.keys()].sort()).toEqual(
      ["/Applications", DESTINATION, SOURCE].sort(),
    );
    expect(commandsRun(invocations)).not.toContain("open");
  });

  it("skips opening the app with --no-open", async () => {
    const { install, invocations } = harness();

    expect(await install(["--no-open"])).toBe(0);

    expect(commandsRun(invocations)).toContain(LSREGISTER);
    expect(commandsRun(invocations)).not.toContain("open");
  });

  it("asks a copy running from the destination to quit and installs once it exits, ignoring a copy running elsewhere", async () => {
    const listings = ["4242\n5151\n", "4242\n5151\n", "5151\n"];
    const { install, invocations, tree } = harness({
      files: {
        "/Applications": "folder",
        [SOURCE]: "new build",
        [DESTINATION]: "Homebrew 0.0.7",
      },
      pgrep: () => exit(0, listings.shift() ?? "5151\n"),
      commandLines: {
        "4242": INSTALLED_EXECUTABLE,
        "5151": `${SOURCE}/Contents/MacOS/Patchdesk --remote-debugging-port=9233`,
      },
    });

    expect(await install()).toBe(0);

    const commands = commandsRun(invocations);
    expect(invocations).toContainEqual({
      command: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "tell application (item 1 of argv) to quit",
        "-e",
        "end run",
        DESTINATION,
      ],
    });
    expect(commands.indexOf("osascript")).toBeLessThan(
      commands.indexOf("ditto"),
    );
    expect(tree.get(DESTINATION)).toBe("new build");
  });

  it("gives up without copying or killing anything when the running copy does not quit", async () => {
    const { install, invocations, tree, sleeps, stderr } = harness({
      files: {
        "/Applications": "folder",
        [SOURCE]: "new build",
        [DESTINATION]: "Homebrew 0.0.7",
      },
      pgrep: () => exit(0, "4242\n"),
    });

    expect(await install()).toBe(1);

    expect(stderr.join("")).toContain("Patchdesk is still running");
    expect(
      sleeps.reduce((total, milliseconds) => total + milliseconds, 0),
    ).toBe(20_000);
    const commands = commandsRun(invocations);
    expect(commands).not.toContain("ditto");
    expect(commands.filter((command) => /kill/.test(command))).toEqual([]);
    expect(tree.get(DESTINATION)).toBe("Homebrew 0.0.7");
  });

  it("points at pnpm package:mac when there is no packaged app", async () => {
    const { install, invocations, stderr } = harness({
      files: { "/Applications": "folder" },
    });

    expect(await install()).toBe(1);

    expect(stderr.join("")).toContain("pnpm package:mac");
    expect(invocations).toEqual([]);
  });

  it("rejects a relative PATCHDESK_INSTALL_DIR", async () => {
    const { install, invocations, stderr } = harness({
      environment: { PATCHDESK_INSTALL_DIR: "~/Applications" },
    });

    expect(await install()).toBe(1);

    expect(stderr.join("")).toContain("PATCHDESK_INSTALL_DIR");
    expect(invocations).toEqual([]);
  });
});
