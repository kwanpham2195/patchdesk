#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile as fsReadFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSourcePaths } from "./lint-staged-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const baselineFileName = "lint-baseline.json";

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
 * @typedef {(path: string) => Promise<string>} ReadFile
 */

/**
 * @typedef {{
 *   readonly stdout: (text: string) => void;
 *   readonly stderr: (text: string) => void;
 * }} CommandOutput
 */

/**
 * Run changed-source quality checks for exactly one base/head pair, then
 * check the repo-wide Oxlint finding count against the committed baseline.
 *
 * @param {{
 *   readonly args: ReadonlyArray<string>;
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly fileExists?: (path: string) => Promise<boolean>;
 *   readonly readFile?: ReadFile;
 *   readonly output: CommandOutput;
 * }} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function checkChangedSource({
  args,
  cwd,
  run,
  fileExists,
  readFile,
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

  const sourceCheckResult = await checkSourcePaths(result.stdout.split("\0"), {
    cwd,
    run,
    fileExists,
    output,
    base,
    head,
  });
  if (sourceCheckResult !== 0) return sourceCheckResult;

  return checkLintRatchet({ cwd, run, fileExists, readFile, output });
}

/**
 * Compare the repo-wide Oxlint finding count against the committed baseline
 * in `lint-baseline.json` and fail if the count rose.
 *
 * The ratchet lets M0a-M0c land legacy-finding cleanups in any order while
 * blocking new findings from piling up, without yet requiring the repo-wide
 * count to be zero. Scans the working tree as it stands (uncommitted changes
 * included), unlike the changed-source checks above, which only look at the
 * committed diff between two refs.
 *
 * @param {{
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly fileExists?: (path: string) => Promise<boolean>;
 *   readonly readFile?: ReadFile;
 *   readonly output: CommandOutput;
 * }} options
 * @returns {Promise<number>} A process-style exit code.
 */
async function checkLintRatchet({
  cwd,
  run,
  fileExists = defaultFileExists,
  readFile = defaultReadFile,
  output,
}) {
  const baseline = await readLintBaseline(cwd, readFile, output);
  if (baseline === undefined) return 1;

  const oxlint = await pinnedTool("oxlint", cwd, fileExists, output);
  if (oxlint === undefined) return 1;

  const result = await execute(
    run,
    oxlint,
    ["--deny-warnings", "--format=json"],
    cwd,
    output,
  );
  if (result === undefined) return 1;
  if (result.signal !== null) {
    output.stderr(`Oxlint (repo-wide) exited via signal ${result.signal}.\n`);
    replay(result, output);
    return 1;
  }

  const count = countOxlintFindings(result.stdout, output);
  if (count === undefined) {
    replay(result, output);
    return 1;
  }

  if (count > baseline.findings) {
    output.stderr(
      `Repo-wide Oxlint findings rose from ${baseline.findings} to ${count}.\n` +
        `${baselineFileName} blocks new findings above the recorded count. ` +
        `Fix the new finding(s), or raise "findings" in ${baselineFileName} only when the increase is deliberate and reviewed.\n`,
    );
    return 1;
  }

  if (count < baseline.findings) {
    output.stdout(
      `Repo-wide Oxlint findings fell from ${baseline.findings} to ${count}.\n` +
        `Lower "findings" in ${baselineFileName} to ${count} to lock in the improvement.\n`,
    );
    return 0;
  }

  output.stdout(
    `Repo-wide Oxlint findings unchanged at ${count} (see ${baselineFileName}).\n`,
  );
  return 0;
}

/**
 * @param {string} cwd
 * @param {ReadFile} readFile
 * @param {CommandOutput} output
 * @returns {Promise<{ readonly findings: number } | undefined>}
 */
async function readLintBaseline(cwd, readFile, output) {
  const path = resolve(cwd, baselineFileName);
  let content;
  try {
    content = await readFile(path);
  } catch (cause) {
    output.stderr(
      `Could not read ${baselineFileName}: ${describeCause(cause)}\n`,
    );
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    output.stderr(
      `${baselineFileName} is not valid JSON: ${describeCause(cause)}\n`,
    );
    return undefined;
  }

  const findings = Object(parsed).findings;
  if (!Number.isInteger(findings) || findings < 0) {
    output.stderr(
      `${baselineFileName} must have a non-negative integer "findings" field.\n`,
    );
    return undefined;
  }
  return { findings };
}

/**
 * @param {string} stdout
 * @param {CommandOutput} output
 * @returns {number | undefined}
 */
function countOxlintFindings(stdout, output) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    output.stderr(
      `Oxlint (repo-wide) did not return parseable JSON: ${describeCause(cause)}\n`,
    );
    return undefined;
  }
  const diagnostics = Object(parsed).diagnostics;
  if (!Array.isArray(diagnostics)) {
    output.stderr(
      "Oxlint (repo-wide) JSON output is missing a diagnostics array.\n",
    );
    return undefined;
  }
  return diagnostics.length;
}

/**
 * Resolves one of the repository's pinned tools to its exact path under
 * `node_modules/.bin`, never a same-named binary on PATH. See
 * `scripts/lint-staged-lib.mjs`'s `pinnedTool` for the full rationale.
 *
 * @param {string} name
 * @param {string} cwd
 * @param {(path: string) => Promise<boolean>} fileExists
 * @param {CommandOutput} output
 * @returns {Promise<string | undefined>}
 */
async function pinnedTool(name, cwd, fileExists, output) {
  const path = resolve(cwd, "node_modules", ".bin", name);
  if (await fileExists(path)) return path;
  output.stderr(
    `${name} is not installed at node_modules/.bin/${name}. Run pnpm install.\n` +
      `The lint ratchet uses this repository's pinned tools, never a copy on PATH.\n`,
  );
  return undefined;
}

async function defaultFileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @type {ReadFile} */
async function defaultReadFile(path) {
  return fsReadFile(path, "utf8");
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
