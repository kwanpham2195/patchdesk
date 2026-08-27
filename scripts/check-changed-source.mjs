#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  execute,
  hasExit,
  processOutput,
  replay,
  resolveCommitRef,
  spawnCommand,
} from "./gate-command-lib.mjs";
import { checkSourcePaths } from "./lint-staged-lib.mjs";
import { checkLintRatchet } from "./quality-ratchet-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

/**
 * Run changed-source quality checks for exactly one base/head pair, then
 * check the repo-wide Oxlint finding count against the baseline committed at
 * `head`.
 *
 * This is the pull-request shape of the gate. The commit shape lives in
 * `lintStaged` (`scripts/lint-staged-lib.mjs`), which runs the same ratchet
 * against the index instead of a commit pair.
 *
 * @param {{
 *   readonly args: ReadonlyArray<string>;
 *   readonly cwd: string;
 *   readonly run: import("./gate-command-lib.mjs").RunCommand;
 *   readonly fileExists?: (path: string) => Promise<boolean>;
 *   readonly output: import("./gate-command-lib.mjs").CommandOutput;
 * }} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function checkChangedSource({
  args,
  cwd,
  run,
  fileExists,
  output,
}) {
  if (args.length !== 2 || args.some((value) => value.trim().length === 0)) {
    output.stderr("Usage: pnpm lint:changed -- <base> <head>\n");
    return 2;
  }

  const [baseRef, headRef] = args;
  const base = await resolveCommitRef(baseRef, "base", { cwd, run, output });
  if (base === undefined) return 1;
  const head = await resolveCommitRef(headRef, "head", { cwd, run, output });
  if (head === undefined) return 1;
  const result = await execute(run, "git", diffArgs(base, head), cwd, output);
  if (result === undefined) return 1;
  if (!hasExit(result, 0)) {
    output.stderr(
      `git changed-source discovery failed (status=${String(result.status)}, signal=${String(result.signal)}).\n`,
    );
    replay(result, output);
    return 1;
  }

  const changedPaths = result.stdout
    .split("\0")
    .filter((path) => path.length > 0);

  const sourceCheckResult = await checkSourcePaths(changedPaths, {
    cwd,
    run,
    fileExists,
    output,
    base,
    head,
  });
  if (sourceCheckResult !== 0) return sourceCheckResult;

  return checkLintRatchet({
    cwd,
    run,
    fileExists,
    output,
    revision: head,
    changedPaths,
  });
}

/**
 * `D` is in the filter so a deleted `.oxlintrc.json`, or a deleted rule file
 * under `tools/oxlint/`, still reaches the count ratchet's configuration
 * rule. The source checks consume the same list and are unharmed: a path
 * deleted at `head` is not on disk, so `checkSourcePaths` filters it out
 * before any tool or line count reads it.
 */
function diffArgs(base, head) {
  return [
    "diff",
    "--name-only",
    "--diff-filter=ACDMR",
    "-z",
    `${base}...${head}`,
  ];
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  process.exitCode = await checkChangedSource({
    args,
    cwd: projectRoot,
    run: spawnCommand,
    output: processOutput,
  });
}
