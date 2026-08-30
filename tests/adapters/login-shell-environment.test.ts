import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  mergeLoginShellEnvironment,
  readLoginShellEnvironment,
} from "../../src/adapters/process/login-shell-environment";

const GUI_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const LOGIN_SHELL_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

class FakeLoginShellProcess extends EventEmitter {
  readonly stdout = new Readable({ read: () => undefined });
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

type FakeLoginShellRun = {
  readonly stdout?: string;
  readonly exitCode?: number;
  /** Emits nothing and never closes, which is what a shell stuck in its startup files looks like. */
  readonly hang?: boolean;
  /** Emits `error` instead of closing, the way Node reports a missing executable. */
  readonly error?: boolean;
};

type FakeSpawnCall = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdio: ReadonlyArray<string>;
  readonly shell: boolean;
};

function fakeLoginShell(
  run: FakeLoginShellRun,
  calls: Array<FakeSpawnCall> = [],
  processes: Array<FakeLoginShellProcess> = [],
) {
  return (
    command: string,
    args: Array<string>,
    options: { stdio: Array<"ignore" | "pipe">; shell: boolean },
  ) => {
    calls.push({
      command,
      args,
      stdio: options.stdio,
      shell: options.shell,
    });
    const child = new FakeLoginShellProcess();
    processes.push(child);
    if (run.error === true) {
      setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
    } else if (run.hang !== true) {
      setImmediate(() => {
        if (run.stdout !== undefined) child.stdout.push(run.stdout);
        child.stdout.push(null);
        child.emit("close", run.exitCode ?? 0);
      });
    }
    return child;
  };
}

describe("mergeLoginShellEnvironment", () => {
  it("imports an allowlisted credential and leaves everything else in the login shell", () => {
    const merge = mergeLoginShellEnvironment(
      {},
      {
        DEEPSEEK_API_KEY: "shell-key",
        AWS_SECRET_ACCESS_KEY: "shell-aws-secret",
        SSH_AUTH_SOCK: "/private/tmp/agent.sock",
        HOMEBREW_PREFIX: "/opt/homebrew",
        npm_config_registry: "https://example.invalid",
      },
      ["DEEPSEEK_API_KEY", "AWS_SECRET_ACCESS_KEY"],
    );

    expect(merge.variables).toEqual({
      DEEPSEEK_API_KEY: "shell-key",
      AWS_SECRET_ACCESS_KEY: "shell-aws-secret",
    });
    expect(merge.importedNames).toEqual([
      "AWS_SECRET_ACCESS_KEY",
      "DEEPSEEK_API_KEY",
    ]);
    expect(merge.pathReplaced).toBe(false);
  });

  it("never overwrites a variable this process already has", () => {
    const merge = mergeLoginShellEnvironment(
      { DEEPSEEK_API_KEY: "terminal-key", OPENAI_API_KEY: "" },
      { DEEPSEEK_API_KEY: "shell-key", OPENAI_API_KEY: "shell-key" },
      ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
    );

    expect(merge.variables).toEqual({});
    expect(merge.importedNames).toEqual([]);
  });

  it("replaces the macOS GUI PATH a Dock launch inherits", () => {
    const merge = mergeLoginShellEnvironment(
      { PATH: GUI_PATH },
      { PATH: LOGIN_SHELL_PATH },
      [],
    );

    expect(merge.variables).toEqual({ PATH: LOGIN_SHELL_PATH });
    expect(merge.importedNames).toEqual(["PATH"]);
    expect(merge.pathReplaced).toBe(true);
  });

  it("keeps a PATH that carries a directory the login shell does not have", () => {
    const merge = mergeLoginShellEnvironment(
      { PATH: `/repo/node_modules/.bin:${GUI_PATH}` },
      { PATH: LOGIN_SHELL_PATH },
      [],
    );

    expect(merge.variables).toEqual({});
    expect(merge.pathReplaced).toBe(false);
  });

  it("reports no PATH change when the two PATHs are already the same", () => {
    const merge = mergeLoginShellEnvironment(
      { PATH: LOGIN_SHELL_PATH },
      { PATH: LOGIN_SHELL_PATH },
      [],
    );

    expect(merge.variables).toEqual({});
    expect(merge.pathReplaced).toBe(false);
  });

  it("keeps a PATH that holds the same directories in a different order", () => {
    const merge = mergeLoginShellEnvironment(
      { PATH: "/usr/bin:/opt/homebrew/bin:/opt/homebrew/bin:/bin" },
      { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
      [],
    );

    expect(merge.variables).toEqual({});
    expect(merge.pathReplaced).toBe(false);
  });

  it("adopts the login shell PATH when this process has none", () => {
    const merge = mergeLoginShellEnvironment(
      {},
      { PATH: LOGIN_SHELL_PATH },
      [],
    );

    expect(merge.pathReplaced).toBe(true);
  });

  it("imports nothing when the login shell printed nothing", () => {
    const merge = mergeLoginShellEnvironment({ PATH: GUI_PATH }, {}, [
      "DEEPSEEK_API_KEY",
    ]);

    expect(merge.variables).toEqual({});
    expect(merge.pathReplaced).toBe(false);
  });
});

describe("readLoginShellEnvironment", () => {
  it("runs the login shell once with no interpolated command and reads NUL-separated pairs", async () => {
    const calls: Array<FakeSpawnCall> = [];
    const environment = await readLoginShellEnvironment({
      shellPath: "/bin/zsh",
      spawnProcess: fakeLoginShell(
        { stdout: "PATH=/opt/homebrew/bin\0DEEPSEEK_API_KEY=shell-key\0" },
        calls,
      ),
    });

    expect(calls).toEqual([
      {
        command: "/bin/zsh",
        args: ["-ilc", "env -0"],
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      },
    ]);
    expect(environment).toEqual({
      PATH: "/opt/homebrew/bin",
      DEEPSEEK_API_KEY: "shell-key",
    });
  });

  it("keeps a multi-line value whole and drops malformed records", async () => {
    const environment = await readLoginShellEnvironment({
      shellPath: "/bin/zsh",
      spawnProcess: fakeLoginShell({
        stdout:
          "GOOGLE_APPLICATION_CREDENTIALS=line one\nline two\0=novalue\0no-equals-sign\0BAD NAME=x\0" +
          "1STARTS_WITH_DIGIT=x\0OK=fine\0",
      }),
    });

    expect(environment).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: "line one\nline two",
      OK: "fine",
    });
  });

  it("imports nothing and kills the shell when it does not answer in time", async () => {
    const processes: Array<FakeLoginShellProcess> = [];
    const environment = await readLoginShellEnvironment({
      shellPath: "/bin/zsh",
      timeoutMs: 20,
      spawnProcess: fakeLoginShell({ hang: true }, [], processes),
    });

    expect(environment).toEqual({});
    expect(processes.map((child) => child.killed)).toEqual([true]);
  });

  it("imports nothing when the login shell exits nonzero", async () => {
    const environment = await readLoginShellEnvironment({
      shellPath: "/bin/zsh",
      spawnProcess: fakeLoginShell({
        stdout: "DEEPSEEK_API_KEY=shell-key\0",
        exitCode: 1,
      }),
    });

    expect(environment).toEqual({});
  });

  it("imports nothing when the shell reports a start failure", async () => {
    const environment = await readLoginShellEnvironment({
      shellPath: "/bin/zsh",
      spawnProcess: fakeLoginShell({ error: true }),
    });

    expect(environment).toEqual({});
  });

  it("imports nothing when spawning the shell throws", async () => {
    const environment = await readLoginShellEnvironment({
      spawnProcess: () => {
        throw new Error("spawn /bin/zsh ENOENT");
      },
    });

    expect(environment).toEqual({});
  });
});
