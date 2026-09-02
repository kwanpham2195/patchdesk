#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { processOutput, spawnCommand } from "./gate-command-lib.mjs";
import { WORKING_TREE, checkSourcePaths } from "./lint-staged-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

/**
 * Run the commit gate's source checks over named paths, before anything is
 * staged.
 *
 * Same three checks `pnpm lint:staged` applies -- the Oxfmt check, Oxlint with
 * denied warnings, and the size ratchet -- against the same shared
 * implementation, so the two gates cannot drift apart. The only difference is
 * where the files are read: `WORKING_TREE` instead of the index, because the
 * point of this command is to meet the gate when a slice is done rather than
 * discovering seventy files' worth of findings at commit time.
 *
 * Non-source paths are dropped, so naming a whole slice's files (a `.md` among
 * them) is fine.
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
export async function gatePreflight({ args, cwd, run, fileExists, output }) {
  const paths = args.filter((value) => value.trim().length > 0);
  if (paths.length === 0) {
    output.stderr(
      "Usage: pnpm gate:preflight <path>..., for example pnpm gate:preflight src/services/review.ts\n",
    );
    return 2;
  }

  // `fileExists` is optional on `CheckSourcePathsOptions`, and the repository
  // compiles with `exactOptionalPropertyTypes`, so an absent override must be
  // omitted rather than passed through as an explicit `undefined`.
  const fileExistsField = fileExists === undefined ? {} : { fileExists };
  return checkSourcePaths(paths, {
    cwd,
    run,
    ...fileExistsField,
    output,
    label: "gate:preflight",
    noun: "source",
    base: "HEAD",
    head: WORKING_TREE,
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  process.exitCode = await gatePreflight({
    args,
    cwd: projectRoot,
    run: spawnCommand,
    output: processOutput,
  });
}
