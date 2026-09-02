import { describe, expect, it } from "vitest";

import { gatePreflight } from "../../scripts/gate-preflight.mjs";
import {
  WORKING_TREE,
  checkFileSizes,
} from "../../scripts/lint-staged-lib.mjs";

type CommandResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

const cwd = "/fixture/project";

const success = (stdout = ""): CommandResult => ({
  status: 0,
  signal: null,
  stdout,
  stderr: "",
});

const absent = (): CommandResult => ({
  status: 128,
  signal: null,
  stdout: "",
  stderr: "fatal: path does not exist",
});

function harness(existingPaths: ReadonlySet<string>) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = async (
    command: string,
    args: ReadonlyArray<string>,
  ): Promise<CommandResult> => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "rev-parse") return success("sha\n");
    if (command === "git" && args[0] === "diff") return success("");
    if (command === "git" && args[0] === "show") return absent();
    return success();
  };

  return {
    calls,
    stdout,
    stderr,
    options: {
      cwd,
      run,
      fileExists: async (path: string) => existingPaths.has(path),
      output: {
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
      },
    },
  };
}

const installed = new Set([
  `${cwd}/node_modules/.bin/oxfmt`,
  `${cwd}/node_modules/.bin/oxlint`,
]);

describe("gatePreflight", () => {
  it("asks for paths rather than guessing at a set of files", async () => {
    const fixture = harness(installed);
    const exitCode = await gatePreflight({ args: [], ...fixture.options });

    expect(exitCode).toBe(2);
    expect(fixture.stderr.join("")).toContain("Usage: pnpm gate:preflight");
    expect(fixture.calls).toEqual([]);
  });

  it("treats an argument list of only blanks as no paths at all", async () => {
    const fixture = harness(installed);
    const exitCode = await gatePreflight({ args: ["  "], ...fixture.options });

    expect(exitCode).toBe(2);
  });

  it("drops the non-source paths a slice's file list carries", async () => {
    const fixture = harness(installed);
    const exitCode = await gatePreflight({
      args: ["AGENTS.md", "docs/architecture.md"],
      ...fixture.options,
    });

    expect(exitCode).toBe(0);
    expect(fixture.stdout.join("")).toBe(
      "gate:preflight: no source files to check.\n",
    );
  });

  it("checks the named source files with the repository's pinned tools", async () => {
    const fixture = harness(
      new Set([...installed, `${cwd}/src/services/review.ts`]),
    );
    const exitCode = await gatePreflight({
      args: ["src/services/review.ts"],
      ...fixture.options,
    });

    expect(exitCode).toBe(0);
    expect(fixture.calls).toContain(
      `${cwd}/node_modules/.bin/oxfmt --check --no-error-on-unmatched-pattern src/services/review.ts`,
    );
    expect(fixture.calls).toContain(
      `${cwd}/node_modules/.bin/oxlint --deny-warnings --no-error-on-unmatched-pattern src/services/review.ts`,
    );
    expect(fixture.stdout.join("")).toContain(
      "gate:preflight: checked 1 source file(s).",
    );
  });
});

describe("the size ratchet at a working-tree head", () => {
  const file = "src/big.ts";
  const lines = (count: number) =>
    `${Array.from({ length: count }, (_, index) => `const value${index} = ${index};`).join("\n")}\n`;

  /**
   * Runs the ratchet with `WORKING_TREE` as head, so the file's current size
   * comes from disk rather than from a revision -- which is the whole point of
   * a gate that runs before anything is staged.
   */
  async function ratchet(baseContent: string, workingContent: string | null) {
    const stderr: string[] = [];
    const calls: string[] = [];
    const result = await checkFileSizes([file], {
      cwd,
      run: async (command: string, args: ReadonlyArray<string>) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (args[0] === "rev-parse") return success("sha\n");
        if (args[0] === "show") return success(baseContent);
        return success("");
      },
      base: "HEAD",
      head: WORKING_TREE,
      readWorkingFile: async () => workingContent,
      output: { stdout: () => {}, stderr: (text: string) => stderr.push(text) },
    });
    return { result, stderr: stderr.join(""), calls };
  }

  it("refuses growth past the ceiling that only the working tree has", async () => {
    const outcome = await ratchet(lines(1000), lines(1001));

    expect(outcome.result).toBe(1);
    expect(outcome.stderr).toContain("src/big.ts grew from 1000 to 1001 lines");
  });

  it("never asks git to read the working tree as a revision", async () => {
    const outcome = await ratchet(lines(10), lines(20));

    expect(outcome.result).toBe(0);
    expect(outcome.calls).toEqual([
      "git rev-parse --verify --end-of-options HEAD^{tree}",
      "git show HEAD:src/big.ts",
    ]);
  });

  it("skips a file the working tree no longer has", async () => {
    const outcome = await ratchet(lines(10), null);

    expect(outcome.result).toBe(0);
    expect(outcome.calls).toEqual([]);
  });
});
