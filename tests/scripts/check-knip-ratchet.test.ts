import { describe, expect, it } from "vitest";

import { checkKnipCount } from "../../scripts/check-knip-ratchet.mjs";

type CommandCall = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

type CommandResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

type HarnessOptions = {
  /** Null-delimited changed-path list the git discovery call reports. */
  readonly changedOutput?: string;
  /** `knip-baseline.json`'s `issues` value at the change under test. */
  readonly baselineIssues?: number;
  /** Raw committed `knip-baseline.json` content. Overrides `baselineIssues`. */
  readonly baselineContent?: string;
  /** Raw `git show <revision>:knip-baseline.json` result. Overrides both. */
  readonly baselineResult?: CommandResult;
  /** Issue count the Knip run reports, spread over one file entry. */
  readonly knipIssueCount?: number;
  /** Raw Knip result. Overrides `knipIssueCount`. */
  readonly knipResult?: CommandResult;
  readonly installedTools?: ReadonlySet<string>;
  /**
   * Paths the change under test holds, as `git ls-files --stage` (index) or
   * `git ls-tree <head>` (commit) reports them. The configuration rule asks
   * git this rather than reading the changed-path list, because a file
   * carried through a change unchanged produces no diff entry. Defaults to a
   * tracked `knip-baseline.json`.
   */
  readonly carriedPaths?: ReadonlySet<string>;
};

const cwd = "/fixture/project";

/** Where the gate must find a pinned tool: never a same-named binary on PATH. */
const pinned = (name: string): string => `${cwd}/node_modules/.bin/${name}`;

const PINNED_TOOLS: ReadonlySet<string> = new Set(["node_modules/.bin/knip"]);

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

/**
 * Knip's JSON reporter groups issues per file, one array per issue kind. The
 * ratchet counts every entry of every one of those arrays, so this spreads
 * `count` across two kinds to prove it adds them up rather than reading a
 * single array's length.
 */
function knipJson(count: number): string {
  const exports_ = Math.ceil(count / 2);
  return JSON.stringify({
    issues: [
      {
        file: "src/example.ts",
        exports: Array.from({ length: exports_ }, () => ({})),
        types: Array.from({ length: count - exports_ }, () => ({})),
        dependencies: [],
      },
    ],
  });
}

function createHarness(options: HarnessOptions = {}) {
  const calls: Array<CommandCall> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const installedTools = options.installedTools ?? PINNED_TOOLS;
  const carriedPaths = options.carriedPaths ?? new Set(["knip-baseline.json"]);
  const baselineResult =
    options.baselineResult ??
    success(
      options.baselineContent ??
        JSON.stringify({ issues: options.baselineIssues ?? 0 }),
    );
  const knipResult =
    options.knipResult ?? success(knipJson(options.knipIssueCount ?? 0));

  const run = async (
    command: string,
    args: ReadonlyArray<string>,
  ): Promise<CommandResult> => {
    calls.push({ command, args });
    if (command === "git" && args[0] === "rev-parse") {
      if (args.includes("base-sha^{commit}"))
        return success(`${resolvedBase}\n`);
      if (args.includes("head-sha^{commit}"))
        return success(`${resolvedHead}\n`);
      return failure("fatal: bad revision", 128);
    }
    if (
      command === "git" &&
      (args[0] === "ls-files" || args[0] === "ls-tree")
    ) {
      const path = args[args.length - 1];
      return path !== undefined && carriedPaths.has(path)
        ? success(`100644 blob ${"0".repeat(40)}\t${path}\n`)
        : success("");
    }
    if (command === "git" && args[0] === "show") return baselineResult;
    if (command === "git" && args[0] === "diff")
      return success(options.changedOutput ?? "src/example.ts\0");
    return knipResult;
  };

  return {
    calls,
    stdout,
    stderr,
    options: {
      args: [] as ReadonlyArray<string>,
      cwd,
      run,
      fileExists: async (path: string) =>
        installedTools.has(path.slice(cwd.length + 1)),
      output: {
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
      },
    },
  };
}

describe("checkKnipCount", () => {
  it("reads the staged change when given no arguments", async () => {
    const harness = createHarness({ baselineIssues: 6, knipIssueCount: 6 });

    await expect(checkKnipCount(harness.options)).resolves.toBe(0);
    // `git diff --cached` needs no history, so this works on the first
    // commit in a repository and in a shallow clone alike.
    expect(harness.calls[0]).toMatchObject({
      command: "git",
      args: ["diff", "--cached", "--name-only", "--diff-filter=ACDMR", "-z"],
    });
    // The baseline is read out of the index, never out of the working tree.
    expect(harness.calls[1]).toMatchObject({
      command: "git",
      args: ["show", ":knip-baseline.json"],
    });
    expect(harness.calls[2]).toMatchObject({
      command: pinned("knip"),
      args: ["--reporter", "json", "--no-exit-code"],
    });
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Knip issues unchanged at 6",
    );
  });

  it("reads the given commit pair when given a base and a head", async () => {
    const harness = createHarness({ baselineIssues: 2, knipIssueCount: 2 });

    await expect(
      checkKnipCount({ ...harness.options, args: ["base-sha", "head-sha"] }),
    ).resolves.toBe(0);
    expect(harness.calls[2]).toMatchObject({
      command: "git",
      args: [
        "diff",
        "--name-only",
        "--diff-filter=ACDMR",
        "-z",
        `${resolvedBase}...${resolvedHead}`,
      ],
    });
    expect(harness.calls[3]).toMatchObject({
      command: "git",
      args: ["show", `${resolvedHead}:knip-baseline.json`],
    });
  });

  it("counts every issue array in the report, not just the first", async () => {
    const harness = createHarness({ baselineIssues: 7, knipIssueCount: 7 });

    await expect(checkKnipCount(harness.options)).resolves.toBe(0);
    expect(harness.stdout.join("")).toContain(
      "Repo-wide Knip issues unchanged at 7",
    );
  });

  it("fails when the issue count rises above the baseline", async () => {
    const harness = createHarness({ baselineIssues: 4, knipIssueCount: 6 });

    await expect(checkKnipCount(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Repo-wide Knip issues rose from 4 to 6",
    );
  });

  it("fails when the issue count falls without the baseline following it down", async () => {
    const harness = createHarness({ baselineIssues: 10, knipIssueCount: 4 });

    await expect(checkKnipCount(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Repo-wide Knip issues fell from 10 to 4",
    );
    expect(harness.stderr.join("")).toContain(
      'Set "issues" in knip-baseline.json to 4',
    );
  });

  it("fails when knip.json changed and knip-baseline.json is not in the index", async () => {
    const harness = createHarness({
      changedOutput: "knip.json\0",
      carriedPaths: new Set(),
      baselineIssues: 5,
      knipIssueCount: 5,
    });

    await expect(checkKnipCount(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "knip.json changed but knip-baseline.json is not staged in this change.",
    );
    expect(harness.stderr.join("")).toContain(
      "accept the new lower number as the truth",
    );
  });

  it("passes when knip.json and knip-baseline.json changed together", async () => {
    const harness = createHarness({
      changedOutput: "knip.json\0knip-baseline.json\0",
      baselineIssues: 5,
      knipIssueCount: 5,
    });

    await expect(checkKnipCount(harness.options)).resolves.toBe(0);
    expect(harness.stderr.join("")).toBe("");
  });

  it("passes a knip.json change that moves no count, with the tracked baseline staged unchanged", async () => {
    // The configuration rule is keyed on the baseline being in the index, not
    // on its content differing, so a config edit with nothing to recount is
    // committable rather than needing a cosmetic baseline edit.
    const harness = createHarness({
      changedOutput: "knip.json\0",
      baselineIssues: 5,
      knipIssueCount: 5,
    });

    await expect(checkKnipCount(harness.options)).resolves.toBe(0);
    expect(harness.stderr.join("")).toBe("");
    expect(
      harness.calls.some(
        ({ command, args }) =>
          command === "git" &&
          args.join(" ") === "ls-files --stage -- knip-baseline.json",
      ),
    ).toBe(true);
  });

  it("fails when knip-baseline.json is absent from the change under test", async () => {
    const harness = createHarness({
      baselineResult: failure("fatal: path does not exist", 128),
    });

    await expect(checkKnipCount(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Could not read knip-baseline.json at the staged index",
    );
  });

  it("fails when Knip's output is not parseable JSON", async () => {
    const harness = createHarness({ knipResult: success("not json") });

    await expect(checkKnipCount(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Knip (repo-wide) did not return parseable JSON",
    );
  });

  it("fails when Knip's JSON has no issues array", async () => {
    const harness = createHarness({
      knipResult: success(JSON.stringify({ notIssues: [] })),
    });

    await expect(checkKnipCount(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "Knip (repo-wide) JSON output is missing an issues array.",
    );
  });

  it("refuses to run a knip that is missing from node_modules", async () => {
    const harness = createHarness({ installedTools: new Set() });

    await expect(checkKnipCount(harness.options)).resolves.toBe(1);
    expect(harness.stderr.join("")).toContain(
      "knip is not installed at node_modules/.bin/knip",
    );
    expect(harness.stderr.join("")).toContain("never a copy on PATH");
  });

  it("rejects an argument count it cannot make sense of", async () => {
    const harness = createHarness();

    await expect(
      checkKnipCount({ ...harness.options, args: ["only-one"] }),
    ).resolves.toBe(2);
    expect(harness.calls).toHaveLength(0);
    expect(harness.stderr.join("")).toContain("Usage:");
  });
});
