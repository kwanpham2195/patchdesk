#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSourcePaths } from "./lint-staged-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

/**
 * @typedef {{
 *   readonly status: number | null;
 *   readonly signal: string | null;
 *   readonly stdout: string;
 *   readonly stderr: string;
 * }} CommandResult
 */

/**
 * @typedef {(
 *   command: string,
 *   args: ReadonlyArray<string>,
 *   cwd: string,
 * ) => Promise<CommandResult>} RunCommand
 */

/**
 * @typedef {{
 *   readonly stdout: (text: string) => void;
 *   readonly stderr: (text: string) => void;
 * }} CommandOutput
 */

/**
 * Run changed-source quality checks for exactly one base/head pair.
 *
 * @param {{
 *   readonly args: ReadonlyArray<string>;
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly fileExists?: (path: string) => Promise<boolean>;
 *   readonly output: CommandOutput;
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

  return checkSourcePaths(result.stdout.split("\0"), {
    cwd,
    run,
    fileExists,
    output,
  });
}

function diffArgs(base, head) {
  return [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
    `${base}...${head}`,
  ];
}

async function resolveCommitRef(ref, name, { cwd, run, output }) {
  const result = await execute(
    run,
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd,
    output,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    output.stderr(`git could not resolve the ${name} commit reference.\n`);
    replay(result, output);
    return undefined;
  }
  const resolved = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(resolved)) {
    output.stderr(`git returned an invalid ${name} commit reference.\n`);
    return undefined;
  }
  return resolved;
}

async function execute(run, command, args, cwd, output) {
  try {
    const result = await run(command, args, cwd);
    if (isCommandResult(result)) return result;
    output.stderr(`${command} returned an invalid process result.\n`);
  } catch (cause) {
    output.stderr(`${command} could not start: ${describeCause(cause)}\n`);
  }
  return undefined;
}

function isCommandResult(value) {
  if (value === null || value === undefined) return false;
  const candidate = Object(value);
  return (
    Object.hasOwn(candidate, "status") &&
    Object.hasOwn(candidate, "signal") &&
    Object.hasOwn(candidate, "stdout") &&
    Object.hasOwn(candidate, "stderr") &&
    (value.status === null || Number.isInteger(value.status)) &&
    (value.signal === null || isString(value.signal)) &&
    isString(value.stdout) &&
    isString(value.stderr)
  );
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

function hasExit(result, status) {
  return result.signal === null && result.status === status;
}

function replay(result, output) {
  if (result.stdout.length > 0) output.stdout(result.stdout);
  if (result.stderr.length > 0) output.stderr(result.stderr);
}

function describeCause(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) =>
      resolveRun({ status, signal, stdout, stderr }),
    );
  });
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
    run,
    output: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  });
}
