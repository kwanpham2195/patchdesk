import { describe, expect, it } from "vitest";

import { checkFileSizes, lintStaged } from "../../scripts/lint-staged-lib.mjs";

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
  readonly installedTools?: ReadonlySet<string>;
  /**
   * `git show` result keyed by its `<revision>:<path>` argument, for the
   * size ratchet. When this is left unset entirely, any `git show` call
   * gets `DEFAULT_SHOW_CONTENT` (a few short lines), which never trips the
   * ratchet, so tests that are not about file sizes do not need to know it
   * runs at all. Once a test configures ANY spec here, every other spec the
   * ratchet reads must be configured too -- an unlisted spec then reports
   * "absent", the same as a real revision that does not have that path.
   * This mirrors reality and keeps an unconfigured spec from silently
   * masking a bug (see the size-ratchet rename tests below).
   */
  readonly showResults?: ReadonlyMap<string, CommandResult>;
  /**
   * The base/head rename pairing the size ratchet asks for whenever a
   * changed path is absent under its own name at `base` (see
   * `loadRenameMap` in `lint-staged-lib.mjs`). Keyed by the path's name at
   * `head`, valued by its name at `base`. Defaults to no renames.
   */
  readonly renameMap?: ReadonlyMap<string, string>;
};

const cwd = "/fixture/project";

/** Where the gate must find a pinned tool: never a same-named binary on PATH. */
const pinned = (name: string): string => `${cwd}/node_modules/.bin/${name}`;

/** Well under every size-ratchet limit, so unrelated tests never trip it. */
const DEFAULT_SHOW_CONTENT = "one\ntwo\nthree\n";

/**
 * Encodes a rename map into the `git diff --name-status -M -z` output the
 * size ratchet's rename lookup parses. Each entry becomes one `R100`
 * (old-path, new-path) record; an empty/absent map means "no renames",
 * matching a real diff over a change that contains none.
 */
function renameDiffStdout(
  renameMap: ReadonlyMap<string, string> | undefined,
): string {
  if (renameMap === undefined) return "";
  let stdout = "";
  for (const [newPath, oldPath] of renameMap) {
    stdout += `R100\0${oldPath}\0${newPath}\0`;
  }
  return stdout;
}

const PINNED_TOOLS: ReadonlySet<string> = new Set([
  "node_modules/.bin/oxfmt",
  "node_modules/.bin/oxlint",
]);

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
  const installedTools = options.installedTools ?? PINNED_TOOLS;
  const partiallyStagedPaths =
    options.partiallyStagedPaths ?? new Set<string>();
  const toolResults = options.toolResults ?? new Map<string, CommandResult>();

  const run = async (
    command: string,
    args: ReadonlyArray<string>,
    commandCwd: string,
  ): Promise<CommandResult> => {
    calls.push({ command, args, cwd: commandCwd });
    if (command === "git" && args[0] === "rev-parse")
      return success("deadbeef\n");
    if (
      command === "git" &&
      args[0] === "diff" &&
      args.includes("--name-status")
    )
      return success(renameDiffStdout(options.renameMap));
    if (command === "git" && args[0] === "diff" && args[1] === "--cached")
      return success(stagedOutput);
    if (command === "git" && args[0] === "diff" && args[1] === "--quiet") {
      const path = args[args.length - 1];
      return path !== undefined && partiallyStagedPaths.has(path)
        ? failure("unstaged changes")
        : success();
    }
    if (command === "git" && args[0] === "show") {
      const spec = args[1];
      const configured =
        spec === undefined ? undefined : options.showResults?.get(spec);
      if (configured !== undefined) return configured;
      if (options.showResults !== undefined && options.showResults.size > 0) {
        return failure(`fatal: path '${String(spec)}' does not exist`, 128);
      }
      return success(DEFAULT_SHOW_CONTENT);
    }
    const tool = command.startsWith(`${cwd}/node_modules/.bin/`)
      ? command.slice(`${cwd}/node_modules/.bin/`.length)
      : command;
    if (options.rejectedCommand === tool) throw new Error("spawn failed");
    const result = toolResults.get(tool);
    return result ?? success();
  };

  return {
    calls,
    stdout,
    stderr,
    options: {
      cwd,
      run,
      fileExists: async (path: string) => {
        const relative = path.slice(cwd.length + 1);
        if (relative.startsWith("node_modules/.bin/"))
          return installedTools.has(relative);
        return existingPaths.has(path) || existingPaths.has(relative);
      },
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
      "git",
      "git",
      "git",
      pinned("oxfmt"),
      pinned("oxlint"),
    ]);
    expect(harness.calls[0]).toMatchObject({
      command: "git",
      args: ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
      cwd,
    });
    // The size ratchet reads the staged (index) content and the last
    // commit's content before either quality tool runs: `head` is `""`, so
    // `git show :path` reads the index, and `base` is `HEAD`. `base` is
    // validated (`rev-parse`) the first time it is actually read.
    expect(harness.calls[2]).toMatchObject({
      command: "git",
      args: ["show", ":src/example.ts"],
      cwd,
    });
    expect(harness.calls[3]).toMatchObject({
      command: "git",
      args: ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      cwd,
    });
    expect(harness.calls[4]).toMatchObject({
      command: "git",
      args: ["show", "HEAD:src/example.ts"],
      cwd,
    });
    expect(harness.calls[5]).toMatchObject({
      command: pinned("oxfmt"),
      args: ["--check", "--no-error-on-unmatched-pattern", "src/example.ts"],
      cwd,
    });
    expect(harness.calls[6]).toMatchObject({
      command: pinned("oxlint"),
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
      "git",
      "git",
      "git",
      pinned("oxfmt"),
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
      "git",
      "git",
      "git",
      pinned("oxfmt"),
      pinned("oxlint"),
    ]);
    expect(harness.calls[6]?.args).toContain("--deny-warnings");
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
    expect(harness.calls[5]?.args.at(-1)).toBe("src/renamed.ts");
  });

  it("passes a staged rename whose new path is over 500 lines but was under the limit at its old, committed path", async () => {
    // Reproduces the real bug: `--diff-filter=ACMR` reports only the new
    // path for a rename, so `git show HEAD:<newpath>` fails -- not because
    // the file is new, but because it lived under a different name at
    // HEAD. Without the rename fix, this would be misread as a 550-line
    // new file and rejected under the 500-line new-file limit.
    const harness = createHarness({
      stagedOutput: "src/renamed.ts\0",
      existingPaths: new Set(["src/renamed.ts"]),
      showResults: new Map([
        [":src/renamed.ts", success(linesOf(550))],
        ["HEAD:src/renamed.ts", failure("fatal: path does not exist", 128)],
        ["HEAD:src/original.ts", success(linesOf(500))],
      ]),
      renameMap: new Map([["src/renamed.ts", "src/original.ts"]]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.stderr.join("")).toBe("");
  });

  it("still fails a staged rename whose new path grew past 1,000 lines, naming both counts", async () => {
    const harness = createHarness({
      stagedOutput: "src/renamed.ts\0",
      existingPaths: new Set(["src/renamed.ts"]),
      showResults: new Map([
        [":src/renamed.ts", success(linesOf(1010))],
        ["HEAD:src/renamed.ts", failure("fatal: path does not exist", 128)],
        ["HEAD:src/original.ts", success(linesOf(1001))],
      ]),
      renameMap: new Map([["src/renamed.ts", "src/original.ts"]]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain("src/renamed.ts");
    expect(harness.stderr.join("")).toContain("1001");
    expect(harness.stderr.join("")).toContain("1010");
    expect(harness.stderr.join("")).toContain("Move something out");
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
    expect(harness.calls[5]?.args.at(-1)).toBe(path);
  });

  it("reports a command process failure and fails closed", async () => {
    const harness = createHarness({ rejectedCommand: "oxfmt" });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain("spawn failed");
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "git",
      "git",
      "git",
      pinned("oxfmt"),
    ]);
  });

  it("refuses to run a tool missing from node_modules rather than one on PATH", async () => {
    const harness = createHarness({
      installedTools: new Set(["node_modules/.bin/oxlint"]),
    });

    // Falling back to a same-named binary on PATH is what this guards
    // against: an editor's older oxfmt disagrees with the pinned one, so it
    // would reject files `pnpm format:check` considers correct.
    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "git",
      "git",
      "git",
    ]);
    expect(harness.stderr.join("")).toContain(
      "oxfmt is not installed at node_modules/.bin/oxfmt",
    );
    expect(harness.stderr.join("")).toContain("never a copy on PATH");
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

  it("fails the size ratchet before running Oxfmt or Oxlint, reading HEAD as base and the index as head", async () => {
    const harness = createHarness({
      showResults: new Map([
        ["HEAD:src/example.ts", success(linesOf(1001))],
        [":src/example.ts", success(linesOf(1002))],
      ]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "git",
      "git",
      "git",
    ]);
    expect(harness.stderr.join("")).toContain("src/example.ts");
    expect(harness.stderr.join("")).toContain("1001");
    expect(harness.stderr.join("")).toContain("1002");
    expect(harness.stderr.join("")).toContain("Move something out");
  });
});

/** `n` lines of trivial, distinct content, newline-terminated like a real file. */
function linesOf(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;
}

describe("checkFileSizes", () => {
  const file = "src/big.ts";
  const base = "base-rev";
  const head = "head-rev";

  /** A successful `git show` result reporting `n` lines. */
  function linesResult(n: number): CommandResult {
    return success(linesOf(n));
  }

  /**
   * @param showResults `git show` result keyed by its `<revision>:<path>`
   *   argument. Every spec the ratchet reads must be listed -- an
   *   unconfigured spec throws, rather than silently standing in for
   *   whatever the real command would have done.
   * @param options.revisionFailures `git rev-parse --verify` failures keyed
   *   by the bare revision (no `^{commit}` suffix). An unlisted revision
   *   validates successfully; this is only for exercising a bad revision.
   * @param options.renameResults The base/head rename pairing `git diff
   *   --name-status -M` reports, keyed by the new path, valued by the old
   *   path. Defaults to no renames (an empty diff).
   */
  function harness(
    showResults: ReadonlyMap<string, CommandResult>,
    options: {
      readonly revisionFailures?: ReadonlyMap<string, CommandResult>;
      readonly renameResults?: ReadonlyMap<string, string>;
    } = {},
  ) {
    const calls: Array<{ readonly args: ReadonlyArray<string> }> = [];
    const stderr: string[] = [];
    const run = async (
      command: string,
      args: ReadonlyArray<string>,
    ): Promise<CommandResult> => {
      calls.push({ args });
      expect(command).toBe("git");
      if (args[0] === "rev-parse") {
        const revisionArg = args.at(-1);
        const revision = revisionArg?.endsWith("^{commit}")
          ? revisionArg.slice(0, -"^{commit}".length)
          : undefined;
        const configured =
          revision === undefined
            ? undefined
            : options.revisionFailures?.get(revision);
        return configured ?? success(`${String(revision)}\n`);
      }
      if (args[0] === "diff") {
        return success(renameDiffStdout(options.renameResults));
      }
      expect(args[0]).toBe("show");
      const spec = args[1];
      const configured = spec === undefined ? undefined : showResults.get(spec);
      if (configured === undefined)
        throw new Error(`no fixture configured for git show ${String(spec)}`);
      return configured;
    };
    return {
      calls,
      stderr,
      run,
      output: {
        stdout: () => {},
        stderr: (text: string) => stderr.push(text),
      },
    };
  }

  it("fails a file already over 1,000 lines at base that grows by one line at head", async () => {
    const h = harness(
      new Map([
        [`${head}:${file}`, linesResult(1002)],
        [`${base}:${file}`, linesResult(1001)],
      ]),
    );

    const result = await checkFileSizes([file], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(1);
    expect(h.stderr.join("")).toContain(file);
    expect(h.stderr.join("")).toContain("1001");
    expect(h.stderr.join("")).toContain("1002");
    expect(h.stderr.join("")).toContain("Move something out");
  });

  it("passes a file over 1,000 lines at base that shrinks at head", async () => {
    const h = harness(
      new Map([
        [`${head}:${file}`, linesResult(999)],
        [`${base}:${file}`, linesResult(1001)],
      ]),
    );

    const result = await checkFileSizes([file], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(0);
    expect(h.stderr.join("")).toBe("");
  });

  it("does not fail a file at exactly 1,000 lines at base that grows to 1,001", async () => {
    // Literal reading of the S1 rule: the gate blocks files already OVER
    // 1,000 lines. A file at exactly 1,000 has not crossed that line yet,
    // so this one growth is allowed; the next growth (1,001 -> 1,002) is not.
    const h = harness(
      new Map([
        [`${head}:${file}`, linesResult(1001)],
        [`${base}:${file}`, linesResult(1000)],
      ]),
    );

    const result = await checkFileSizes([file], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(0);
    expect(h.stderr.join("")).toBe("");
  });

  it("fails a new file (absent at base) with 501 lines at head", async () => {
    const h = harness(
      new Map([
        [`${head}:${file}`, linesResult(501)],
        [`${base}:${file}`, failure("fatal: path does not exist", 128)],
      ]),
    );

    const result = await checkFileSizes([file], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(1);
    expect(h.stderr.join("")).toContain(file);
    expect(h.stderr.join("")).toContain("501");
    expect(h.stderr.join("")).toContain("Move something out");
  });

  it("passes a new file (absent at base) with exactly 500 lines at head", async () => {
    const h = harness(
      new Map([
        [`${head}:${file}`, linesResult(500)],
        [`${base}:${file}`, failure("fatal: path does not exist", 128)],
      ]),
    );

    const result = await checkFileSizes([file], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(0);
    expect(h.stderr.join("")).toBe("");
  });

  it("passes a renamed file over 500 lines by reading its old path's line count at base", async () => {
    // The changed-file list only ever names the NEW path
    // (`--diff-filter=ACMR`), so a plain `git show <base>:<newpath>` fails
    // here -- not because the file is new, but because it lived under
    // "src/old.ts" at `base`. Before this fix, that failure was misread as
    // "new file", and 550 lines would have been rejected under the
    // 500-line new-file limit.
    const renamed = "src/renamed.ts";
    const oldPath = "src/old.ts";
    const h = harness(
      new Map([
        [`${head}:${renamed}`, linesResult(550)],
        [`${base}:${renamed}`, failure("fatal: path does not exist", 128)],
        [`${base}:${oldPath}`, linesResult(500)],
      ]),
      { renameResults: new Map([[renamed, oldPath]]) },
    );

    const result = await checkFileSizes([renamed], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(0);
    expect(h.stderr.join("")).toBe("");
  });

  it("fails a renamed file that was over 1,000 lines at its old path and grew, naming both counts", async () => {
    const renamed = "src/renamed.ts";
    const oldPath = "src/old.ts";
    const h = harness(
      new Map([
        [`${head}:${renamed}`, linesResult(1010)],
        [`${base}:${renamed}`, failure("fatal: path does not exist", 128)],
        [`${base}:${oldPath}`, linesResult(1001)],
      ]),
      { renameResults: new Map([[renamed, oldPath]]) },
    );

    const result = await checkFileSizes([renamed], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(1);
    expect(h.stderr.join("")).toContain(renamed);
    expect(h.stderr.join("")).toContain("1001");
    expect(h.stderr.join("")).toContain("1010");
    expect(h.stderr.join("")).toContain("Move something out");
  });

  it("fails loudly, without silently passing, when the base revision cannot be resolved", async () => {
    // Reproduces the second bug: a bad revision and a merely-absent path
    // both make `git show` exit nonzero, so without validating the
    // revision up front, this used to be misread as "absent at base" (a
    // new file) and pass silently -- even for a 3,299-line file it never
    // actually read.
    const h = harness(new Map([[`${head}:${file}`, linesResult(3299)]]), {
      revisionFailures: new Map([[base, failure("fatal: bad revision", 128)]]),
    });

    const result = await checkFileSizes([file], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(1);
    expect(h.stderr.join("")).toContain(base);
    expect(h.stderr.join("")).toContain("could not resolve");
    // The head lookup (3,299 lines) must never be trusted into a silent
    // pass once the base revision itself is confirmed bad.
    expect(
      h.calls.some(
        (call) => call.args[0] === "show" && call.args[1] === `${base}:${file}`,
      ),
    ).toBe(false);
  });

  it("skips a *.generated.ts file, however large, without even reading it", async () => {
    const generated = "src/adapters/pi/pi-ai-catalog.generated.ts";
    const calls: Array<unknown> = [];
    const run = async (): Promise<CommandResult> => {
      calls.push(undefined);
      throw new Error("checkFileSizes must not read a generated file");
    };
    const stderr: string[] = [];

    const result = await checkFileSizes([generated], {
      cwd,
      run,
      base,
      head,
      output: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });

    expect(result).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stderr.join("")).toBe("");
  });

  it("does not crash on a file deleted at head", async () => {
    const h = harness(
      new Map([
        [`${head}:${file}`, failure("fatal: path does not exist", 128)],
      ]),
    );

    const result = await checkFileSizes([file], {
      cwd,
      run: h.run,
      base,
      head,
      output: h.output,
    });

    expect(result).toBe(0);
    expect(h.stderr.join("")).toBe("");
    // Only head's revision and content should have been read: once a file is
    // confirmed gone at head, there is nothing left to ratchet, so base is
    // never validated or read.
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]?.args[0]).toBe("rev-parse");
    expect(h.calls[1]?.args).toEqual(["show", `${head}:${file}`]);
  });

  it("fails closed, without throwing, when git cannot be started", async () => {
    const stderr: string[] = [];
    const run = async (): Promise<CommandResult> => {
      throw new Error("spawn failed");
    };

    const result = await checkFileSizes([file], {
      cwd,
      run,
      base,
      head,
      output: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });

    expect(result).toBe(1);
    expect(stderr.join("")).toContain("spawn failed");
  });
});
