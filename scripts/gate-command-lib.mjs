import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * The process plumbing every quality gate entry script shares: how a command
 * is run, how its result is validated, and how one of this repository's
 * pinned tools is found.
 *
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
 * Resolve `ref` to a full commit SHA, refusing anything git will not confirm
 * is a commit. Shared by every entry point that takes a base/head pair.
 *
 * @param {string} ref
 * @param {string} name
 * @param {{
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly output: CommandOutput;
 * }} context
 * @returns {Promise<string | undefined>}
 */
export async function resolveCommitRef(ref, name, { cwd, run, output }) {
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

/**
 * Resolves one of the repository's pinned tools to its exact path under
 * `node_modules/.bin`.
 *
 * Deliberately never falls back to a same-named binary on PATH. A developer
 * whose editor installs its own oxfmt (a Mason or Homebrew copy, say) would
 * otherwise have the commit gate check staged files with a different version
 * than `pnpm format:check` uses, and the two disagree: an older oxfmt rejects
 * files this repository formats correctly, and reformatting to satisfy it
 * breaks the repository check instead. A tool missing from `node_modules` is
 * a setup problem, so it is reported as one.
 *
 * Every gate resolves its tool through here -- the commit gate's oxfmt and
 * oxlint, and the count ratchets' oxlint and knip -- so the message names the
 * gates as a whole rather than any one of them.
 *
 * @param {string} name
 * @param {string} cwd
 * @param {(path: string) => Promise<boolean>} fileExists
 * @param {CommandOutput} output
 * @returns {Promise<string | undefined>}
 */
export async function pinnedTool(name, cwd, fileExists, output) {
  const path = resolve(cwd, "node_modules", ".bin", name);
  if (await fileExists(path)) return path;
  output.stderr(
    `${name} is not installed at node_modules/.bin/${name}. Run pnpm install.\n` +
      `The quality gates use this repository's pinned tools, never a copy on PATH.\n`,
  );
  return undefined;
}

/**
 * Run one command and resolve its complete result. The single spawn helper
 * every gate entry script passes as its `run`.
 *
 * @type {RunCommand}
 */
export function spawnCommand(command, args, cwd) {
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

/** Writes to the real process streams. The default for every entry script. */
export const processOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function defaultFileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {RunCommand} run
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {string} cwd
 * @param {CommandOutput} output
 * @returns {Promise<CommandResult | undefined>}
 */
export async function execute(run, command, args, cwd, output) {
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

export function hasExit(result, status) {
  return result.signal === null && result.status === status;
}

export function replay(result, output) {
  if (result.stdout.length > 0) output.stdout(result.stdout);
  if (result.stderr.length > 0) output.stderr(result.stderr);
}

export function describeCause(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
