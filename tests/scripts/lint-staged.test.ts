import { describe, expect, it } from "vitest";

import { lintStaged } from "../../scripts/lint-staged-lib.mjs";

type CommandCall = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
};

type CommandResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

type HarnessOptions = {
  readonly stagedOutput?: string;
  readonly existingPaths?: ReadonlySet<string>;
  readonly partiallyStagedPaths?: ReadonlySet<string>;
  readonly toolResults?: ReadonlyMap<string, CommandResult>;
  readonly rejectedCommand?: string;
};

const cwd = "/fixture/project";

const success = (stdout = ""): CommandResult => ({
  status: 0,
  signal: null,
  stdout,
  stderr: "",
});

const failure = (stderr: string, status = 1): CommandResult => ({
  status,
  signal: null,
  stdout: "",
  stderr,
});

function createHarness(options: HarnessOptions = {}) {
  const calls: Array<CommandCall> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stagedOutput = options.stagedOutput ?? "src/example.ts\0";
  const existingPaths = options.existingPaths ?? new Set(["src/example.ts"]);
  const partiallyStagedPaths =
    options.partiallyStagedPaths ?? new Set<string>();
  const toolResults = options.toolResults ?? new Map<string, CommandResult>();

  const run = async (
    command: string,
    args: ReadonlyArray<string>,
    commandCwd: string,
  ): Promise<CommandResult> => {
    calls.push({ command, args, cwd: commandCwd });
    if (command === "git" && args[0] === "diff" && args[1] === "--cached")
      return success(stagedOutput);
    if (command === "git" && args[0] === "diff" && args[1] === "--quiet") {
      const path = args[args.length - 1];
      return path !== undefined && partiallyStagedPaths.has(path)
        ? failure("unstaged changes")
        : success();
    }
    if (options.rejectedCommand === command) throw new Error("spawn failed");
    const result = toolResults.get(command);
    return result ?? success();
  };

  return {
    calls,
    stdout,
    stderr,
    options: {
      cwd,
      run,
      fileExists: async (path: string) =>
        existingPaths.has(path) ||
        existingPaths.has(path.slice(cwd.length + 1)),
      output: {
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
      },
    },
  };
}

describe("lintStaged", () => {
  it("returns cleanly when no staged source files exist", async () => {
    const harness = createHarness({
      stagedOutput: "README.md\0",
      existingPaths: new Set(),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.stdout.join("")).toContain("no staged source files");
  });

  it("checks a clean staged source file with Oxfmt before Oxlint", async () => {
    const harness = createHarness();

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "oxfmt",
      "oxlint",
    ]);
    expect(harness.calls[0]).toMatchObject({
      command: "git",
      args: ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
      cwd,
    });
    expect(harness.calls[2]).toMatchObject({
      command: "oxfmt",
      args: ["--check", "--no-error-on-unmatched-pattern", "src/example.ts"],
      cwd,
    });
    expect(harness.calls[3]).toMatchObject({
      command: "oxlint",
      args: [
        "--deny-warnings",
        "--no-error-on-unmatched-pattern",
        "src/example.ts",
      ],
      cwd,
    });
  });

  it("stops when Oxfmt fails and preserves its output", async () => {
    const harness = createHarness({
      toolResults: new Map([["oxfmt", failure("format error")]]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "oxfmt",
    ]);
    expect(harness.stderr.join("")).toContain("format error");
    expect(harness.stderr.join("")).toContain("pnpm exec oxfmt --write");
  });

  it("fails when Oxlint reports a warning or error", async () => {
    const harness = createHarness({
      toolResults: new Map([["oxlint", failure("lint warning")]]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "oxfmt",
      "oxlint",
    ]);
    expect(harness.calls[3]?.args).toContain("--deny-warnings");
    expect(harness.stderr.join("")).toContain("lint warning");
    expect(harness.stderr.join("")).toContain("pnpm exec oxlint --fix");
  });

  it("rejects partial staging before running either quality tool", async () => {
    const harness = createHarness({
      partiallyStagedPaths: new Set(["src/example.ts"]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual(["git", "git"]);
    expect(harness.stderr.join("")).toContain(
      "Cannot safely check partially staged source files.",
    );
    expect(harness.stderr.join("")).toContain("src/example.ts");
  });

  it("includes renamed source paths from the staged name list", async () => {
    const harness = createHarness({
      stagedOutput: "src/renamed.ts\0",
      existingPaths: new Set(["src/renamed.ts"]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.calls[1]?.args).toEqual([
      "diff",
      "--quiet",
      "--",
      "src/renamed.ts",
    ]);
    expect(harness.calls[2]?.args.at(-1)).toBe("src/renamed.ts");
  });

  it("rejects a staged source path deleted only from the working tree", async () => {
    const harness = createHarness({
      existingPaths: new Set(),
      partiallyStagedPaths: new Set(["src/example.ts"]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual(["git", "git"]);
    expect(harness.stderr.join("")).toContain(
      "Cannot safely check partially staged source files.",
    );
  });

  it("keeps a path containing spaces as one command argument", async () => {
    const path = "src/file with spaces.ts";
    const harness = createHarness({
      stagedOutput: `${path}\0`,
      existingPaths: new Set([path]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.calls[1]?.args).toEqual(["diff", "--quiet", "--", path]);
    expect(harness.calls[2]?.args.at(-1)).toBe(path);
  });

  it("reports a command process failure and fails closed", async () => {
    const harness = createHarness({ rejectedCommand: "oxfmt" });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain("spawn failed");
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "oxfmt",
    ]);
  });

  it("does not call git add or mutate files", async () => {
    const harness = createHarness();

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(
      harness.calls.some(
        ({ command, args }) => command === "git" && args[0] === "add",
      ),
    ).toBe(false);
  });
});
