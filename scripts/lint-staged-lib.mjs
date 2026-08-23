import { access } from "node:fs/promises";
import { resolve } from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

/**
 * Runs one command from the repository root and returns its complete result.
 * @typedef {(
 *   command: string,
 *   args: ReadonlyArray<string>,
 *   cwd: string,
 * ) => Promise<CommandResult>} RunCommand
 */

/**
 * @typedef {{
 *   readonly status: number | null;
 *   readonly signal: string | null;
 *   readonly stdout: string;
 *   readonly stderr: string;
 * }} CommandResult
 */

/**
 * @typedef {{
 *   readonly stdout: (text: string) => void;
 *   readonly stderr: (text: string) => void;
 * }} CommandOutput
 */

/**
 * @typedef {{
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly fileExists?: (path: string) => Promise<boolean>;
 *   readonly output: CommandOutput;
 * }} LintStagedOptions
 */

/**
 * @typedef {LintStagedOptions} CheckSourcePathsOptions
 */

/**
 * Check staged JavaScript and TypeScript files without changing the index or
 * working tree.
 *
 * @param {LintStagedOptions} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function lintStaged({
  cwd,
  run,
  fileExists = defaultFileExists,
  output,
}) {
  const discovered = await execute(run, "git", discoveryArgs(), cwd, output);
  if (discovered === undefined) return 1;
  if (!hasExit(discovered, 0)) {
    reportUnexpectedExit(output, "git staged-file discovery", discovered);
    return 1;
  }

  const files = selectSourcePaths(splitNullDelimitedPaths(discovered.stdout));
  if (files.length === 0) {
    output.stdout("lint-staged: no staged source files to check.\n");
    return 0;
  }

  const partiallyStaged = [];
  let guardFailed = false;
  for (const file of files) {
    const result = await execute(
      run,
      "git",
      ["diff", "--quiet", "--", file],
      cwd,
      output,
    );
    if (result === undefined) {
      guardFailed = true;
      continue;
    }
    if (hasExit(result, 0)) continue;
    if (hasExit(result, 1)) {
      partiallyStaged.push(file);
      continue;
    }
    reportUnexpectedExit(output, `unstaged-change check for ${file}`, result);
    guardFailed = true;
  }

  if (partiallyStaged.length > 0) {
    output.stderr(
      "Cannot safely check partially staged source files.\n" +
        "Stage or restore all changes in each listed file, then retry.\n" +
        partiallyStaged.map((file) => `- ${file}`).join("\n") +
        "\n",
    );
    guardFailed = true;
  }
  if (guardFailed) return 1;

  return checkSourcePaths(files, { cwd, run, fileExists, output });
}

/**
 * Check explicit JavaScript and TypeScript paths without reading or changing
 * the index or working tree.
 *
 * @param {ReadonlyArray<string>} paths
 * @param {CheckSourcePathsOptions} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function checkSourcePaths(
  paths,
  { cwd, run, fileExists = defaultFileExists, output },
) {
  const files = await selectSourceFiles(paths, cwd, fileExists);
  if (files.length === 0) {
    output.stdout("lint-staged: no source files to check.\n");
    return 0;
  }

  return runSourceQualityChecks(files, { cwd, run, output });
}

async function runSourceQualityChecks(files, { cwd, run, output }) {
  const formatter = await execute(
    run,
    "oxfmt",
    ["--check", "--no-error-on-unmatched-pattern", ...files],
    cwd,
    output,
  );
  if (formatter === undefined) return 1;
  replay(formatter, output);
  if (!hasExit(formatter, 0)) {
    reportUnexpectedExit(output, "Oxfmt", formatter);
    output.stderr(
      `Run pnpm exec oxfmt --write ${formatPaths(files)} after reviewing the changes.\n`,
    );
    return 1;
  }

  const linter = await execute(
    run,
    "oxlint",
    ["--deny-warnings", "--no-error-on-unmatched-pattern", ...files],
    cwd,
    output,
  );
  if (linter === undefined) return 1;
  replay(linter, output);
  if (!hasExit(linter, 0)) {
    reportUnexpectedExit(output, "Oxlint", linter);
    output.stderr(
      `Run pnpm exec oxlint --fix ${formatPaths(files)} after reviewing the changes.\n`,
    );
    return 1;
  }

  output.stdout(
    `lint-staged: checked ${files.length} staged source file(s).\n`,
  );
  return 0;
}

function discoveryArgs() {
  return ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"];
}

async function selectSourceFiles(paths, cwd, fileExists) {
  const candidates = selectSourcePaths(paths);
  const files = [];
  for (const path of candidates) {
    if (await fileExists(resolve(cwd, path))) files.push(path);
  }
  return files;
}

function selectSourcePaths(paths) {
  return paths.filter(
    (path) => path.length > 0 && SOURCE_EXTENSIONS.has(extensionOf(path)),
  );
}

function splitNullDelimitedPaths(stdout) {
  return stdout.split("\0").filter((path) => path.length > 0);
}

function extensionOf(path) {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? "" : path.slice(lastDot).toLowerCase();
}

async function defaultFileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function execute(run, command, args, cwd, output) {
  try {
    const result = await run(command, args, cwd);
    if (isCommandResult(result)) return result;
    output.stderr(
      `The ${command} command returned an invalid process result.\n`,
    );
  } catch (cause) {
    output.stderr(`${command} could not start: ${describeCause(cause)}\n`);
  }
  return undefined;
}

function isCommandResult(value) {
  if (value === null || value === undefined) return false;
  const candidate = Object(value);
  const status = value.status;
  const signal = value.signal;
  return (
    Object.hasOwn(candidate, "status") &&
    Object.hasOwn(candidate, "signal") &&
    Object.hasOwn(candidate, "stdout") &&
    Object.hasOwn(candidate, "stderr") &&
    (status === null || Number.isInteger(status)) &&
    (signal === null || isString(signal)) &&
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

function reportUnexpectedExit(output, command, result) {
  output.stderr(
    `${command} failed (status=${String(result.status)}, signal=${String(result.signal)}).\n`,
  );
}

function describeCause(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatPaths(files) {
  return files.map((file) => JSON.stringify(file)).join(" ");
}
