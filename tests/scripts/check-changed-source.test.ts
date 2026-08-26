import { describe, expect, it } from "vitest";

import { checkChangedSource } from "../../scripts/check-changed-source.mjs";

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
  readonly diffOutput?: string;
  readonly existingPaths?: ReadonlySet<string>;
  readonly toolResults?: ReadonlyMap<string, CommandResult>;
  readonly diffResult?: CommandResult;
};

const cwd = "/fixture/project";

/** Where the gate must find a pinned tool: never a same-named binary on PATH. */
const pinned = (name: string): string => `${cwd}/node_modules/.bin/${name}`;

const PINNED_TOOLS: ReadonlySet<string> = new Set([
  "node_modules/.bin/oxfmt",
  "node_modules/.bin/oxlint",
]);
const resolvedBase = "a".repeat(40);
const resolvedHead = "b".repeat(40);

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
  const existingPaths = options.existingPaths ?? new Set(["src/example.ts"]);
  const toolResults = options.toolResults ?? new Map<string, CommandResult>();

  const run = async (
    command: string,
    args: ReadonlyArray<string>,
    commandCwd: string,
  ): Promise<CommandResult> => {
    calls.push({ command, args, cwd: commandCwd });
    if (command === "git" && args[0] === "rev-parse") {
      if (args.includes("--output=/tmp/changed-source^{commit}"))
        return failure("option-like commit reference", 128);
      return success(
        args.includes("base-sha^{commit}")
          ? `${resolvedBase}\n`
          : `${resolvedHead}\n`,
      );
    }
    if (command === "git")
      return (
        options.diffResult ?? success(options.diffOutput ?? "src/example.ts\0")
      );
    const tool = command.startsWith(`${cwd}/node_modules/.bin/`)
      ? command.slice(`${cwd}/node_modules/.bin/`.length)
      : command;
    return toolResults.get(tool) ?? success();
  };

  return {
    calls,
    stdout,
    stderr,
    options: {
      args: ["base-sha", "head-sha"],
      cwd,
      run,
      fileExists: async (path: string) => {
        const relative = path.slice(cwd.length + 1);
        if (relative.startsWith("node_modules/.bin/"))
          return PINNED_TOOLS.has(relative);
        return existingPaths.has(path) || existingPaths.has(relative);
      },
      output: {
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
      },
    },
  };
}

describe("checkChangedSource", () => {
  it("returns cleanly when the merge-base diff has no source files", async () => {
    const harness = createHarness({
      diffOutput: "README.md\0",
      existingPaths: new Set(),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.calls).toHaveLength(3);
    expect(harness.calls[2]?.args).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      `${resolvedBase}...${resolvedHead}`,
    ]);
  });

  it("checks renamed paths from the merge-base diff", async () => {
    const harness = createHarness({
      diffOutput: "src/renamed.ts\0",
      existingPaths: new Set(["src/renamed.ts"]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.calls[3]?.args.at(-1)).toBe("src/renamed.ts");
  });

  it("keeps paths with spaces as one formatter argument", async () => {
    const path = "src/file with spaces.ts";
    const harness = createHarness({
      diffOutput: `${path}\0`,
      existingPaths: new Set([path]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.calls[3]?.args).toEqual([
      "--check",
      "--no-error-on-unmatched-pattern",
      path,
    ]);
  });

  it("stops when Oxfmt fails", async () => {
    const harness = createHarness({
      toolResults: new Map([["oxfmt", failure("format error")]]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "git",
      pinned("oxfmt"),
    ]);
    expect(harness.stderr.join("")).toContain("format error");
  });

  it("stops when Oxlint fails", async () => {
    const harness = createHarness({
      toolResults: new Map([["oxlint", failure("lint error")]]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "git",
      pinned("oxfmt"),
      pinned("oxlint"),
    ]);
    expect(harness.stderr.join("")).toContain("lint error");
  });

  it("rejects missing or blank commit arguments before running commands", async () => {
    const missing = createHarness();
    const blank = createHarness();

    await expect(
      checkChangedSource({ ...missing.options, args: ["base-sha"] }),
    ).resolves.toBe(2);
    await expect(
      checkChangedSource({ ...blank.options, args: [" ", "head-sha"] }),
    ).resolves.toBe(2);
    expect(missing.calls).toHaveLength(0);
    expect(blank.calls).toHaveLength(0);
    expect(missing.stderr.join("")).toContain("Usage:");
  });

  it("rejects an option-like commit argument before discovery", async () => {
    const harness = createHarness();

    await expect(
      checkChangedSource({
        ...harness.options,
        args: ["--output=/tmp/changed-source", "head-sha"],
      }),
    ).resolves.toBe(1);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.args).toEqual([
      "rev-parse",
      "--verify",
      "--end-of-options",
      "--output=/tmp/changed-source^{commit}",
    ]);
    expect(harness.stderr.join("")).toContain("option-like commit reference");
  });

  it("fails closed when Git rejects the resolved commit range", async () => {
    const harness = createHarness({
      diffResult: failure("unknown revision", 128),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.calls).toHaveLength(3);
    expect(harness.stderr.join("")).toContain("unknown revision");
  });

  it("does not inspect the index or issue mutation commands", async () => {
    const harness = createHarness();

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(
      harness.calls.some(
        ({ command, args }) =>
          command === "git" && (args[1] === "--cached" || args[0] === "add"),
      ),
    ).toBe(false);
    expect(harness.calls[3]?.args).toContain("--check");
    expect(harness.calls[4]?.args).not.toContain("--fix");
  });
});
