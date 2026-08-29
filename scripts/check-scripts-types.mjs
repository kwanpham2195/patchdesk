#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveChangeUnderTest } from "./change-under-test-lib.mjs";
import { processOutput, spawnCommand } from "./gate-command-lib.mjs";
import { checkScriptsTypeRatchet } from "./quality-ratchet-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

/**
 * Compare the `scripts/**` type-error count with
 * `scripts-typecheck-baseline.json`.
 *
 * With no arguments the change under test is the staged one, so the same
 * invocation works from `pnpm check` and from a commit hook. With a base and a
 * head it is that commit pair, which is the shape CI uses. This is the same
 * pair of shapes `pnpm knip:ratchet` takes, and for the same reason.
 *
 * This is NOT part of `pnpm precommit`: the whole `scripts/` tree is
 * type-checked on every run, so it costs a full `tsc` program and answers a
 * repository-wide question rather than one about the staged files.
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
export async function checkScriptsTypeCount({
  args,
  cwd,
  run,
  fileExists,
  output,
}) {
  if (args.length !== 0 && args.length !== 2) {
    output.stderr("Usage: pnpm typecheck:scripts [-- <base> <head>]\n");
    return 2;
  }
  if (args.some((value) => value.trim().length === 0)) {
    output.stderr("Usage: pnpm typecheck:scripts [-- <base> <head>]\n");
    return 2;
  }

  const change = await resolveChangeUnderTest(args, { cwd, run, output });
  if (change === undefined) return 1;

  // `fileExists` is optional on `RatchetOptions`, and the repository compiles
  // with `exactOptionalPropertyTypes`, so an absent override must be omitted
  // rather than passed through as an explicit `undefined`.
  const fileExistsField = fileExists === undefined ? {} : { fileExists };
  return checkScriptsTypeRatchet({
    cwd,
    run,
    ...fileExistsField,
    output,
    ...change,
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  process.exitCode = await checkScriptsTypeCount({
    args,
    cwd: projectRoot,
    run: spawnCommand,
    output: processOutput,
  });
}
