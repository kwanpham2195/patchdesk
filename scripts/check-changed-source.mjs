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
 * Run changed-source quality checks over everything a branch has changed,
 * then check the repo-wide Oxlint finding count against the baseline at the
 * same head.
 *
 * This is the branch shape of the gate. The commit shape lives in
 * `lintStaged` (`scripts/lint-staged-lib.mjs`), which measures one commit's
 * worth of staged change against `HEAD`.
 *
 * Two forms, the same split `pnpm knip:ratchet` uses:
 *
 * - `<base> <head>`, two commits, is what the pull request gates run.
 * - `<base>` alone reads the **index** as head, so `pnpm check` sees the work
 *   in hand rather than only what is already committed. Without it, the one
 *   command a developer runs before handing work over would report on the
 *   state before their fix -- a gate answering about the wrong tree looks
 *   exactly like a gate that works. The base is moved to `git merge-base
 *   <base> HEAD` first, so a base branch that has moved on since the branch
 *   started does not read as changes this branch made.
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
  if (
    (args.length !== 1 && args.length !== 2) ||
    args.some((value) => value.trim().length === 0)
  ) {
    output.stderr("Usage: pnpm lint:changed -- <base> [<head>]\n");
    return 2;
  }

  const [baseRef, headRef] = args;
  let base = await resolveCommitRef(baseRef, "base", { cwd, run, output });
  if (base === undefined) return 1;

  let head = "";
  if (headRef === undefined) {
    base = await mergeBaseWithHead(base, { cwd, run, output });
    if (base === undefined) return 1;
  } else {
    head = await resolveCommitRef(headRef, "head", { cwd, run, output });
    if (head === undefined) return 1;
  }

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

  // `fileExists` is optional on both option bags, and the repository compiles
  // with `exactOptionalPropertyTypes`, so an absent override must be omitted
  // rather than passed through as an explicit `undefined`.
  const fileExistsField = fileExists === undefined ? {} : { fileExists };

  const sourceCheckResult = await checkSourcePaths(changedPaths, {
    cwd,
    run,
    ...fileExistsField,
    output,
    base,
    head,
  });
  if (sourceCheckResult !== 0) return sourceCheckResult;

  return checkLintRatchet({
    cwd,
    run,
    ...fileExistsField,
    output,
    revision: head,
    changedPaths,
  });
}

/**
 * The commit both branches share, so `<base>` alone means "everything this
 * branch changed" and never "everything that changed on the base branch too".
 *
 * @returns {Promise<string | undefined>} `undefined` means git failed,
 *   already reported to `output`.
 */
async function mergeBaseWithHead(base, { cwd, run, output }) {
  const result = await execute(
    run,
    "git",
    ["merge-base", "--end-of-options", base, "HEAD"],
    cwd,
    output,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    output.stderr(
      `git could not find a merge base between the base commit and HEAD (status=${String(result.status)}).\n`,
    );
    replay(result, output);
    return undefined;
  }
  const resolved = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(resolved)) {
    output.stderr("git returned an invalid merge-base commit reference.\n");
    return undefined;
  }
  return resolved;
}

/**
 * `D` is in the filter so a deleted `.oxlintrc.json`, or a deleted rule file
 * under `tools/oxlint/`, still reaches the count ratchet's configuration
 * rule. The source checks consume the same list and are unharmed: a path
 * deleted at `head` is not on disk, so `checkSourcePaths` filters it out
 * before any tool or line count reads it.
 *
 * An empty `head` means the index. `git diff --cached <base>` is the index
 * against that commit, matching `git show :<path>`, which is how
 * `checkFileSizes` and the count ratchet read an empty revision.
 */
function diffArgs(base, head) {
  if (head === "") {
    return [
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACDMR",
      "-z",
      base,
    ];
  }
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
