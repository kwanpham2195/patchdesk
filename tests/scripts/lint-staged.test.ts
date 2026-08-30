import { describe, expect, it } from "vitest";

import { checkFileSizes, lintStaged } from "../../scripts/lint-staged-lib.mjs";
import {
  createHarness,
  cwd,
  EMPTY_TREE,
  failure,
  pinned,
  renameDiffStdout,
  success,
  type CommandResult,
} from "./lint-staged-harness";

describe("lintStaged", () => {
  it("returns cleanly when no staged source files exist", async () => {
    const harness = createHarness({
      stagedOutput: "README.md\0",
      existingPaths: new Set(),
    });

    await expect(lintStaged(harness.options)).resolves.toBe(0);
    // Discovery, then `stagedBase`. The repo-wide Oxlint count ratchet does
    // not run here; it runs once, in `checkChangedSource`
    // (`scripts/check-changed-source.mjs`).
    expect(harness.calls.map(({ command }) => command)).toEqual(["git", "git"]);
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
