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
  /**
   * `lint-baseline.json`'s `findings` value, as the count ratchet reads it
   * out of the index (`git show :lint-baseline.json`). Defaults to 0, which
   * matches the default repo-wide diagnostic count, so tests that are not
   * about the ratchet never trip it.
   */
  readonly baselineFindings?: number;
  /** Raw indexed `lint-baseline.json` content. Overrides `baselineFindings`. */
  readonly baselineContent?: string;
  /** Raw `git show :lint-baseline.json` result. Overrides both of the above. */
  readonly baselineResult?: CommandResult;
  /** Diagnostic count the repo-wide ratchet Oxlint run reports. Defaults to 0. */
  readonly ratchetDiagnosticsCount?: number;
  /** Raw repo-wide ratchet Oxlint result. Overrides `ratchetDiagnosticsCount`. */
  readonly ratchetResult?: CommandResult;
  /** Makes `HEAD` unresolvable, the way an unborn branch does. */
  readonly unbornHead?: boolean;
};

const cwd = "/fixture/project";

/** Git's empty tree, which `stagedBase` falls back to on an unborn branch. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const BASELINE_SPEC_SUFFIX = ":lint-baseline.json";

/**
 * Git reads EVERY argument after `--end-of-options` as a revision, so an
 * option written after that marker is not an option at all and the command
 * fails with "Needed a single revision". A stub that answers any `rev-parse`
 * with a SHA hides that, and hid it once: `--quiet` written after the marker
 * made `stagedBase` believe HEAD was unborn on every commit, which turned
 * every modified file into a "new file" for the size ratchet.
 */
function optionAfterEndOfOptions(
  args: ReadonlyArray<string>,
): CommandResult | undefined {
  const marker = args.indexOf("--end-of-options");
  if (marker === -1 || args.length - marker === 2) return undefined;
  return failure("fatal: Needed a single revision", 128);
}

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
  const baselineResult =
    options.baselineResult ??
    success(
      options.baselineContent ??
        JSON.stringify({ findings: options.baselineFindings ?? 0 }),
    );
  const ratchetResult =
    options.ratchetResult ??
    success(
      JSON.stringify({
        diagnostics: Array.from(
          { length: options.ratchetDiagnosticsCount ?? 0 },
          () => ({}),
        ),
      }),
    );

  const run = async (
    command: string,
    args: ReadonlyArray<string>,
    commandCwd: string,
  ): Promise<CommandResult> => {
    calls.push({ command, args, cwd: commandCwd });
    if (command === "git" && args[0] === "rev-parse") {
      const badOrder = optionAfterEndOfOptions(args);
      if (badOrder !== undefined) return badOrder;
      if (options.unbornHead === true && args.includes("HEAD^{commit}"))
        return failure("fatal: Needed a single revision", 128);
      return success("deadbeef\n");
    }
    if (command === "git" && args[0] === "hash-object")
      return success(`${EMPTY_TREE}\n`);
    if (command === "git" && args[0] === "ls-files") {
      // Real `git ls-files --stage -- lint-baseline.json` prints an index
      // entry for a tracked file whether or not this change touches it, so
      // the only honest answer here is "yes, always" -- which is exactly why
      // the configuration rule cannot be built on it. Throwing keeps any
      // regression that reaches for it visible instead of letting a fake
      // "yes" or "no" decide the gate.
      throw new Error("the configuration rule must not ask git ls-files");
    }
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
      // The count ratchet's baseline read is answered before `showResults`,
      // which only ever describes source files for the size ratchet.
      if (spec !== undefined && spec.endsWith(BASELINE_SPEC_SUFFIX))
        return baselineResult;
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
    // The repo-wide ratchet run and the staged-file run are the same binary;
    // only `--format=json` tells them apart.
    if (tool === "oxlint" && args.includes("--format=json"))
      return ratchetResult;
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
    // Discovery, then `stagedBase`, then the count ratchet's baseline read
    // and its repo-wide Oxlint run. The ratchet runs even with nothing
    // source-like staged, because a lone `.oxlintrc.json` change is exactly
    // what it exists to gate.
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "git",
      pinned("oxlint"),
    ]);
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
      "git",
      pinned("oxfmt"),
      pinned("oxlint"),
      "git",
      pinned("oxlint"),
    ]);
    expect(harness.calls[0]).toMatchObject({
      command: "git",
      args: ["diff", "--cached", "--name-only", "--diff-filter=ACDMR", "-z"],
      cwd,
    });
    // `stagedBase` asks whether HEAD exists at all before anything reads it,
    // so an unborn branch falls back to the empty tree instead of wedging.
    expect(harness.calls[2]).toMatchObject({
      command: "git",
      args: [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "HEAD^{commit}",
      ],
      cwd,
    });
    // The size ratchet reads the staged (index) content and the last
    // commit's content before either quality tool runs: `head` is `""`, so
    // `git show :path` reads the index, and `base` is `HEAD`. `base` is
    // validated (`rev-parse`) the first time it is actually read.
    expect(harness.calls[3]).toMatchObject({
      command: "git",
      args: ["show", ":src/example.ts"],
      cwd,
    });
    expect(harness.calls[4]).toMatchObject({
      command: "git",
      args: ["rev-parse", "--verify", "--end-of-options", "HEAD^{tree}"],
      cwd,
    });
    expect(harness.calls[5]).toMatchObject({
      command: "git",
      args: ["show", "HEAD:src/example.ts"],
      cwd,
    });
    expect(harness.calls[6]).toMatchObject({
      command: pinned("oxfmt"),
      args: ["--check", "--no-error-on-unmatched-pattern", "src/example.ts"],
      cwd,
    });
    expect(harness.calls[7]).toMatchObject({
      command: pinned("oxlint"),
      args: [
        "--deny-warnings",
        "--no-error-on-unmatched-pattern",
        "src/example.ts",
      ],
      cwd,
    });
    // Then the count ratchet: read the baseline the commit would carry, and
    // run Oxlint over the whole repository.
    expect(harness.calls[8]).toMatchObject({
      command: "git",
      args: ["show", ":lint-baseline.json"],
      cwd,
    });
    expect(harness.calls[9]).toMatchObject({
      command: pinned("oxlint"),
      args: ["--deny-warnings", "--format=json"],
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
      "git",
      pinned("oxfmt"),
      pinned("oxlint"),
    ]);
    expect(harness.calls[7]?.args).toContain("--deny-warnings");
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
    expect(harness.calls[6]?.args.at(-1)).toBe("src/renamed.ts");
  });

  it("passes a staged rename whose new path is over 500 lines but was under the limit at its old, committed path", async () => {
    // Reproduces the real bug: `--diff-filter=ACDMR` reports only the new
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
    expect(harness.calls[6]?.args.at(-1)).toBe(path);
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

  it("fails when .oxlintrc.json is staged and lint-baseline.json is not in the change", async () => {
    // Loosening a rule lowers the repo-wide count on its own. Without this
    // gate the count ratchet would read the lower number as an improvement
    // and accept it as the new truth.
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0",
      existingPaths: new Set(),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not staged in this change.",
    );
    expect(harness.stderr.join("")).toContain("silently lowers");
    expect(harness.stderr.join("")).toContain(
      "accept the new lower number as the truth",
    );
    // It fails before paying for a repo-wide Oxlint run.
    expect(
      harness.calls.some(({ args }) => args.includes("--format=json")),
    ).toBe(false);
  });

  it("fails when an Oxlint plugin source is staged and lint-baseline.json is not in the change", async () => {
    // A rule written in plugin JavaScript can be weakened exactly the way a
    // rule written in .oxlintrc.json can.
    const harness = createHarness({
      stagedOutput: "tools/oxlint/anti-slop/index.ts\0",
      existingPaths: new Set(),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not staged in this change.",
    );
  });

  it("passes when .oxlintrc.json and lint-baseline.json are staged together", async () => {
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0lint-baseline.json\0",
      existingPaths: new Set(),
      baselineFindings: 3,
      ratchetDiagnosticsCount: 3,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.stderr.join("")).toBe("");
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Oxlint findings unchanged at 3",
    );
  });

  it("fails an .oxlintrc.json change staged alone, with the tracked baseline left untouched", async () => {
    // THE CASE THE RULE EXISTS FOR, and the one it used to let through. An
    // earlier form asked `git ls-files --stage -- lint-baseline.json` whether
    // the baseline was PRESENT. A tracked file is present unconditionally, so
    // that answer was "yes" for every change: three anti-slop rules could be
    // switched off, staged alone, and committed with every check green.
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0",
      existingPaths: new Set(),
      baselineFindings: 7,
      ratchetDiagnosticsCount: 7,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not staged in this change.",
    );
    expect(harness.stderr.join("")).toContain(
      "Staging lint-baseline.json unchanged does not count",
    );
    // It fails before paying for a repo-wide Oxlint run.
    expect(
      harness.calls.some(({ args }) => args.includes("--format=json")),
    ).toBe(false);
  });

  it("reads the changed-path list rather than asking git whether the baseline is tracked", async () => {
    // The changed-path list is `git diff --cached --name-only`, the change
    // itself. `ls-files`/`ls-tree` answer "is this file tracked", whose
    // answer never varies; the harness throws if anything reaches for one.
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0lint-baseline.json\0",
      existingPaths: new Set(),
      baselineFindings: 7,
      ratchetDiagnosticsCount: 7,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(
      harness.calls.some(
        ({ command, args }) =>
          command === "git" &&
          (args[0] === "ls-files" || args[0] === "ls-tree"),
      ),
    ).toBe(false);
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Oxlint findings unchanged at 7",
    );
  });

  it("does not catch a config change whose findings net back to the same count", async () => {
    // A KNOWN, DELIBERATE HOLE, recorded so nobody mistakes it for closed.
    // Loosening five findings away while adding five new ones leaves the
    // count where the baseline says it should be, so rule 3 passes it and
    // rule 2 has nothing to object to -- the baseline IS correct. No gate
    // that compares one number to one number can tell netting from no
    // change; catching it needs a baseline of finding identities, not of
    // finding totals. The previous content-difference form did not catch it
    // either: one character in an unused "note" field satisfied it.
    const harness = createHarness({
      stagedOutput: ".oxlintrc.json\0lint-baseline.json\0",
      existingPaths: new Set(),
      baselineFindings: 5,
      ratchetDiagnosticsCount: 5,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Oxlint findings unchanged at 5",
    );
  });

  it("puts a staged deletion of an Oxlint plugin file through the configuration rule", async () => {
    // `--diff-filter=ACDMR` includes deletions, so removing a rule file is
    // seen as the configuration change it is. Under `ACMR` it was invisible.
    const harness = createHarness({
      stagedOutput: "tools/oxlint/anti-slop/rules/no-drift.ts\0",
      existingPaths: new Set(),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not staged in this change.",
    );
  });

  it("never reads a deleted source file for a line count or a lint run", async () => {
    // Deletions now reach the changed-path list. A deleted file is not on
    // disk, so `selectSourceFiles` drops it before the size ratchet or
    // either quality tool sees it. The unstaged-change guard still asks
    // about it, which is harmless: index and working tree agree that it is
    // gone, so `git diff --quiet` exits 0.
    const harness = createHarness({
      stagedOutput: "src/example.ts\0src/deleted.ts\0",
      existingPaths: new Set(["src/example.ts"]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    const touching = harness.calls.filter(({ args }) =>
      args.some((arg) => arg.includes("src/deleted.ts")),
    );
    expect(touching.map(({ args }) => args.slice(0, 2).join(" "))).toEqual([
      "diff --quiet",
    ]);
    expect(harness.stdout.join("")).toContain(
      "checked 1 staged source file(s)",
    );
  });

  it("fails when the repo-wide count fell but the staged lint-baseline.json still holds the old number", async () => {
    // The baseline is read with `git show :lint-baseline.json`, so an edit
    // that was never staged reads as the old number and still fails. That
    // is what makes "update the baseline in the same commit" enforceable
    // rather than advice.
    const harness = createHarness({
      baselineFindings: 9,
      ratchetDiagnosticsCount: 4,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Repo-wide Oxlint findings fell from 9 to 4",
    );
    expect(harness.stderr.join("")).toContain(
      'Set "findings" in lint-baseline.json to 4',
    );
    expect(harness.stderr.join("")).toContain("unstaged edits count too");
  });

  it("fails when the repo-wide count rose above the staged baseline", async () => {
    const harness = createHarness({
      baselineFindings: 4,
      ratchetDiagnosticsCount: 5,
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Repo-wide Oxlint findings rose from 4 to 5",
    );
  });

  it("checks the first commit in a repository against git's empty tree instead of wedging on a missing HEAD", async () => {
    // A pre-commit hook runs before the commit exists, so on an unborn
    // branch there is no HEAD -- and no HEAD~1 either, which is why the
    // gate never asks for one. Every staged file reads as new.
    const harness = createHarness({
      unbornHead: true,
      showResults: new Map([[":src/example.ts", success(linesOf(10))]]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    expect(harness.stderr.join("")).toBe("");
    expect(harness.calls.some(({ args }) => args[0] === "hash-object")).toBe(
      true,
    );
    expect(
      harness.calls.some(
        ({ args }) =>
          args[0] === "show" && args[1] === `${EMPTY_TREE}:src/example.ts`,
      ),
    ).toBe(true);
  });

  it("still applies the new-file limit on an unborn branch", async () => {
    const harness = createHarness({
      unbornHead: true,
      showResults: new Map([[":src/example.ts", success(linesOf(501))]]),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain("501");
    expect(harness.stderr.join("")).toContain("new file");
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
   *   by the bare revision (no `^{tree}` suffix). An unlisted revision
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
        const revision = revisionArg?.endsWith("^{tree}")
          ? revisionArg.slice(0, -"^{tree}".length)
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

  it("passes a renamed file over 500 lines by reading its old path's line count at base", async () => {
    // The changed-file list only ever names the NEW path
    // (`--diff-filter=ACDMR`), so a plain `git show <base>:<newpath>` fails
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
