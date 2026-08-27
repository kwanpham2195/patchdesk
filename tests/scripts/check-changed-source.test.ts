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
  /**
   * `lint-baseline.json`'s `findings` value, as the count ratchet reads it
   * out of the commit under test (`git show <head>:lint-baseline.json`),
   * never out of the working tree. Defaults to 0.
   */
  readonly baselineFindings?: number;
  /** Raw committed `lint-baseline.json` content. Overrides `baselineFindings`. */
  readonly baselineContent?: string;
  /** Raw `git show <head>:lint-baseline.json` result. Overrides both above. */
  readonly baselineResult?: CommandResult;
  /** Diagnostic count the repo-wide ratchet run reports. Defaults to 0. */
  readonly ratchetDiagnosticsCount?: number;
  /** Raw ratchet Oxlint result. Overrides `ratchetDiagnosticsCount`. */
  readonly ratchetResult?: CommandResult;
  /**
   * `git show` result keyed by its `<revision>:<path>` argument, for the
   * size ratchet. When this is left unset entirely, any `git show` call
   * gets `DEFAULT_SHOW_CONTENT` (a few short lines), which never trips the
   * ratchet, so tests that are not about file sizes do not need to know it
   * runs at all. Once a test configures ANY spec here, every other spec the
   * ratchet reads must be configured too -- an unlisted spec then reports
   * "absent", the same as a real revision that does not have that path.
   */
  readonly showResults?: ReadonlyMap<string, CommandResult>;
  /**
   * The resolved-base/resolved-head rename pairing the size ratchet asks
   * for whenever a changed path is absent under its own name at the
   * resolved base commit. Keyed by the path's name at head, valued by its
   * name at base. Defaults to no renames.
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
 * (old-path, new-path) record; an empty/absent map means "no renames".
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

const BASELINE_SPEC_SUFFIX = ":lint-baseline.json";

function createHarness(options: HarnessOptions = {}) {
  const calls: Array<CommandCall> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const existingPaths = options.existingPaths ?? new Set(["src/example.ts"]);
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
      if (args.includes("--output=/tmp/changed-source^{commit}"))
        return failure("option-like commit reference", 128);
      if (args.includes("base-sha^{commit}"))
        return success(`${resolvedBase}\n`);
      if (args.includes("head-sha^{commit}"))
        return success(`${resolvedHead}\n`);
      // The size ratchet re-validates the already-resolved base/head
      // commits before reading anything at them; only the exit code (0)
      // matters for that, not this content.
      return success("irrelevant-but-valid\n");
    }
    if (command === "git" && args[0] === "ls-tree") {
      // Real `git ls-tree <head> -- lint-baseline.json` prints a tree entry
      // for a tracked file whether or not the commit under test touches it,
      // so the only honest answer here is "yes, always" -- which is exactly
      // why the configuration rule cannot be built on it. Throwing keeps any
      // regression that reaches for it visible instead of letting a fake
      // "yes" or "no" decide the gate.
      throw new Error("the configuration rule must not ask git ls-tree");
    }
    if (
      command === "git" &&
      args[0] === "diff" &&
      args.includes("--name-status")
    )
      return success(renameDiffStdout(options.renameMap));
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
    if (command === "git")
      return (
        options.diffResult ?? success(options.diffOutput ?? "src/example.ts\0")
      );
    const tool = command.startsWith(`${cwd}/node_modules/.bin/`)
      ? command.slice(`${cwd}/node_modules/.bin/`.length)
      : command;
    if (tool === "oxlint" && args.includes("--format=json"))
      return ratchetResult;
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
    // rev-parse base, rev-parse head, the changed-file diff, the count
    // ratchet's baseline read, then its repo-wide Oxlint run.
    expect(harness.calls).toHaveLength(5);
    expect(harness.calls[2]?.args).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=ACDMR",
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
    expect(harness.calls[7]?.args.at(-1)).toBe("src/renamed.ts");
  });

  it("keeps paths with spaces as one formatter argument", async () => {
    const path = "src/file with spaces.ts";
    const harness = createHarness({
      diffOutput: `${path}\0`,
      existingPaths: new Set([path]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.calls[7]?.args).toEqual([
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
      "git",
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
      "git",
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
    expect(harness.calls[7]?.args).toContain("--check");
    expect(harness.calls[8]?.args).not.toContain("--fix");
  });

  it("fails the lint ratchet when repo-wide findings rise above the baseline", async () => {
    const harness = createHarness({
      baselineFindings: 5,
      ratchetDiagnosticsCount: 6,
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Repo-wide Oxlint findings rose from 5 to 6",
    );
  });

  it("passes the lint ratchet when repo-wide findings equal the baseline", async () => {
    const harness = createHarness({
      baselineFindings: 3,
      ratchetDiagnosticsCount: 3,
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Oxlint findings unchanged at 3",
    );
  });

  it("fails the lint ratchet when repo-wide findings fall without the committed baseline following them down", async () => {
    // A drop nobody records is a drop that can drift back up unnoticed.
    // The baseline is read out of the commit under test, so an edit to
    // lint-baseline.json that was never staged still reads as the old
    // number and still fails here.
    const harness = createHarness({
      baselineFindings: 10,
      ratchetDiagnosticsCount: 4,
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Repo-wide Oxlint findings fell from 10 to 4",
    );
    expect(harness.stderr.join("")).toContain(
      'Set "findings" in lint-baseline.json to 4',
    );
    expect(harness.stderr.join("")).toContain("this same change");
  });

  it("passes the lint ratchet when the commit under test lowers the baseline to the new count", async () => {
    const harness = createHarness({
      diffOutput: "src/example.ts\0lint-baseline.json\0",
      baselineFindings: 4,
      ratchetDiagnosticsCount: 4,
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Oxlint findings unchanged at 4",
    );
    expect(harness.stderr.join("")).toBe("");
  });

  it("fails the lint ratchet when lint-baseline.json is absent from the commit under test", async () => {
    const harness = createHarness({
      baselineResult: failure("fatal: path does not exist", 128),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Could not read lint-baseline.json at commit",
    );
    // "staged" is the wrong word when the change under test is a commit.
    expect(harness.stderr.join("")).toContain(
      "must be committed at that revision before it counts",
    );
    expect(harness.stderr.join("")).not.toContain("must be staged");
  });

  it("fails the lint ratchet when .oxlintrc.json changed and no baseline is committed at head", async () => {
    const harness = createHarness({
      diffOutput: ".oxlintrc.json\0",
      existingPaths: new Set(),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    // The commit shape says "committed", not "staged".
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not committed in this change.",
    );
    // It fails before paying for a repo-wide Oxlint run.
    expect(
      harness.calls.some(({ args }) => args.includes("--format=json")),
    ).toBe(false);
  });

  it("fails an .oxlintrc.json change whose commit pair does not touch the baseline", async () => {
    // The CI half of the same defect. `git ls-tree <head> -- lint-baseline.json`
    // reports the tracked baseline at every commit, so keying the rule on it
    // made this scenario pass; keying it on the commit pair's own diff makes
    // it the rejection it always claimed to be.
    const harness = createHarness({
      diffOutput: ".oxlintrc.json\0",
      existingPaths: new Set(),
      baselineFindings: 2,
      ratchetDiagnosticsCount: 2,
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not committed in this change.",
    );
    expect(harness.stderr.join("")).toContain(
      "Committing lint-baseline.json unchanged does not count",
    );
    expect(
      harness.calls.some(({ args }) => args.includes("--format=json")),
    ).toBe(false);
  });

  it("passes an .oxlintrc.json change committed together with the baseline", async () => {
    const harness = createHarness({
      diffOutput: ".oxlintrc.json\0lint-baseline.json\0",
      existingPaths: new Set(),
      baselineFindings: 2,
      ratchetDiagnosticsCount: 2,
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.stderr.join("")).toBe("");
    // The rule reads the commit pair's diff, never `ls-tree`: the harness
    // throws if anything asks git whether the baseline is merely tracked.
    expect(
      harness.calls.some(
        ({ command, args }) => command === "git" && args[0] === "ls-tree",
      ),
    ).toBe(false);
  });

  it("puts a deleted Oxlint plugin file through the configuration rule", async () => {
    // `--diff-filter=ACDMR` includes deletions, so removing a rule file is
    // seen as the configuration change it is.
    const harness = createHarness({
      diffOutput: "tools/oxlint/anti-slop/rules/no-drift.ts\0",
      existingPaths: new Set(),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      ".oxlintrc.json changed but lint-baseline.json is not committed in this change.",
    );
  });

  it("fails the lint ratchet when lint-baseline.json is not valid JSON", async () => {
    const harness = createHarness({ baselineContent: "not json" });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain("is not valid JSON");
  });

  it("fails the lint ratchet when the findings field is not a non-negative integer", async () => {
    const invalidBaselines = [
      JSON.stringify({}),
      JSON.stringify({ findings: "5" }),
      JSON.stringify({ findings: -1 }),
      JSON.stringify({ findings: 1.5 }),
    ];

    for (const baselineContent of invalidBaselines) {
      const harness = createHarness({ baselineContent });

      await expect(checkChangedSource(harness.options)).resolves.toBe(1);
      expect(harness.stderr.join("")).toContain(
        'lint-baseline.json must have a non-negative integer "findings" field.',
      );
    }
  });

  it("fails the lint ratchet when Oxlint's repo-wide output is not parseable JSON", async () => {
    const harness = createHarness({ ratchetResult: success("not json") });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Oxlint (repo-wide) did not return parseable JSON",
    );
  });

  it("fails the lint ratchet when Oxlint's repo-wide JSON has no diagnostics array", async () => {
    const harness = createHarness({
      ratchetResult: success(JSON.stringify({ notDiagnostics: [] })),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Oxlint (repo-wide) JSON output is missing a diagnostics array.",
    );
  });

  it("fails the lint ratchet when Oxlint exits via a signal", async () => {
    const harness = createHarness({
      ratchetResult: {
        status: null,
        signal: "SIGSEGV",
        stdout: "",
        stderr: "core dumped",
      },
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Oxlint (repo-wide) exited via signal SIGSEGV.",
    );
    expect(harness.stderr.join("")).toContain("core dumped");
  });

  it("fails the size ratchet using the resolved base and head commits, before Oxfmt, Oxlint, or the lint ratchet run", async () => {
    const harness = createHarness({
      showResults: new Map([
        [`${resolvedBase}:src/example.ts`, success(linesOf(1001))],
        [`${resolvedHead}:src/example.ts`, success(linesOf(1002))],
      ]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "git",
      "git",
      "git",
      "git",
      "git",
    ]);
    // calls[3] is the ratchet's own validation of the resolved head commit
    // (`rev-parse`) before it trusts a nonzero `git show` exit as "absent".
    expect(harness.calls[4]?.args).toEqual([
      "show",
      `${resolvedHead}:src/example.ts`,
    ]);
    // calls[5] validates the resolved base commit the same way.
    expect(harness.calls[6]?.args).toEqual([
      "show",
      `${resolvedBase}:src/example.ts`,
    ]);
    expect(harness.stderr.join("")).toContain("src/example.ts");
    expect(harness.stderr.join("")).toContain("1001");
    expect(harness.stderr.join("")).toContain("1002");
    expect(harness.stderr.join("")).toContain("Move something out");
  });

  it("passes the size ratchet and still runs Oxfmt, Oxlint, and the lint ratchet when a changed file is well within the limits", async () => {
    const harness = createHarness({
      showResults: new Map([
        [`${resolvedBase}:src/example.ts`, success(linesOf(10))],
        [`${resolvedHead}:src/example.ts`, success(linesOf(12))],
      ]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.calls.map(({ command }) => command)).toEqual([
      "git",
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
  });

  it("passes a rename between the resolved base and head commits over 500 lines by reading its old path's line count at base", async () => {
    // The changed-file list only ever names the NEW path
    // (`--diff-filter=ACDMR`), so `git show <resolvedBase>:<newpath>` fails
    // here -- not because the file is new, but because it lived under
    // "src/old.ts" at the resolved base commit.
    const renamed = "src/renamed.ts";
    const oldPath = "src/old.ts";
    const harness = createHarness({
      diffOutput: `${renamed}\0`,
      existingPaths: new Set([renamed]),
      showResults: new Map([
        [`${resolvedHead}:${renamed}`, success(linesOf(550))],
        [
          `${resolvedBase}:${renamed}`,
          failure("fatal: path does not exist", 128),
        ],
        [`${resolvedBase}:${oldPath}`, success(linesOf(500))],
      ]),
      renameMap: new Map([[renamed, oldPath]]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(0);
    expect(harness.stderr.join("")).toBe("");
  });

  it("still fails a rename between the resolved base and head commits that grew past 1,000 lines, naming both counts", async () => {
    const renamed = "src/renamed.ts";
    const oldPath = "src/old.ts";
    const harness = createHarness({
      diffOutput: `${renamed}\0`,
      existingPaths: new Set([renamed]),
      showResults: new Map([
        [`${resolvedHead}:${renamed}`, success(linesOf(1010))],
        [
          `${resolvedBase}:${renamed}`,
          failure("fatal: path does not exist", 128),
        ],
        [`${resolvedBase}:${oldPath}`, success(linesOf(1001))],
      ]),
      renameMap: new Map([[renamed, oldPath]]),
    });

    await expect(checkChangedSource(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(renamed);
    expect(harness.stderr.join("")).toContain("1001");
    expect(harness.stderr.join("")).toContain("1010");
    expect(harness.stderr.join("")).toContain("Move something out");
  });
});

/** `n` lines of trivial, distinct content, newline-terminated like a real file. */
function linesOf(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;
}
