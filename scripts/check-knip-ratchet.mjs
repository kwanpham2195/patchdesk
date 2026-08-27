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
import { checkKnipRatchet } from "./quality-ratchet-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

/**
 * Compare the repo-wide Knip issue count with `knip-baseline.json`.
 *
 * With no arguments the change under test is the staged one, so the same
 * invocation works from `pnpm check` and from a commit hook. With a base and
 * a head it is that commit pair, which is the shape CI uses.
 *
 * Knip is NOT part of `pnpm precommit`. Its number answers a whole-project
 * reachability question, so an ordinary mid-refactor commit -- move a helper
 * out of one file now, wire up its new caller in the next commit -- moves the
 * count for a reason that has nothing wrong with it. A gate that rejects that
 * commit gets switched off. `pnpm check`, the pre-handoff gate, and the pull
 * request gates are where the whole project is meant to hang together.
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
export async function checkKnipCount({ args, cwd, run, fileExists, output }) {
  if (args.length !== 0 && args.length !== 2) {
    output.stderr("Usage: pnpm knip:ratchet [-- <base> <head>]\n");
    return 2;
  }
  if (args.some((value) => value.trim().length === 0)) {
    output.stderr("Usage: pnpm knip:ratchet [-- <base> <head>]\n");
    return 2;
  }

  const change =
    args.length === 0
      ? await stagedChange({ cwd, run, output })
      : await commitRangeChange(args, { cwd, run, output });
  if (change === undefined) return 1;

  return checkKnipRatchet({ cwd, run, fileExists, output, ...change });
}

/**
 * The staged change. `git diff --cached` needs no history at all, so this
 * works on the very first commit in a repository as well as in a shallow
 * clone, where `HEAD~1` does not exist.
 */
async function stagedChange({ cwd, run, output }) {
  const args = ["diff", "--cached", "--name-only", "--diff-filter=ACDMR", "-z"];
  const result = await execute(run, "git", args, cwd, output);
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    output.stderr(
      `git staged-file discovery failed (status=${String(result.status)}).\n`,
    );
    replay(result, output);
    return undefined;
  }
  return { revision: "", changedPaths: splitPaths(result.stdout) };
}

async function commitRangeChange(args, { cwd, run, output }) {
  const [baseRef, headRef] = args;
  const base = await resolveCommitRef(baseRef, "base", { cwd, run, output });
  if (base === undefined) return undefined;
  const head = await resolveCommitRef(headRef, "head", { cwd, run, output });
  if (head === undefined) return undefined;

  const result = await execute(
    run,
    "git",
    ["diff", "--name-only", "--diff-filter=ACDMR", "-z", `${base}...${head}`],
    cwd,
    output,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    output.stderr(
      `git changed-file discovery failed (status=${String(result.status)}).\n`,
    );
    replay(result, output);
    return undefined;
  }
  return { revision: head, changedPaths: splitPaths(result.stdout) };
}

function splitPaths(stdout) {
  return stdout.split("\0").filter((path) => path.length > 0);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  process.exitCode = await checkKnipCount({
    args,
    cwd: projectRoot,
    run: spawnCommand,
    output: processOutput,
  });
}
