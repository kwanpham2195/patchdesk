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
 * @typedef {LintStagedOptions & {
 *   readonly base: string;
 *   readonly head: string;
 * }} CheckSourcePathsOptions
 */

/**
 * @typedef {{
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly base: string;
 *   readonly head: string;
 *   readonly output: CommandOutput;
 * }} CheckFileSizesOptions
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

  // `head` is "" (no revision before the colon), which is git's own syntax
  // for reading a path out of the index rather than a commit. The staged
  // content is what is about to be committed, and it is not yet reachable by
  // any commit-ish, so the index is the only right place to read it from.
  // The unstaged-change guard above proves the working tree agrees.
  return checkSourcePaths(files, {
    cwd,
    run,
    fileExists,
    output,
    base: "HEAD",
    head: "",
  });
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
  { cwd, run, fileExists = defaultFileExists, output, base, head },
) {
  const files = await selectSourceFiles(paths, cwd, fileExists);
  if (files.length === 0) {
    output.stdout("lint-staged: no source files to check.\n");
    return 0;
  }

  const sizeResult = await checkFileSizes(files, {
    cwd,
    run,
    base,
    head,
    output,
  });
  if (sizeResult !== 0) return sizeResult;

  return runSourceQualityChecks(files, { cwd, run, fileExists, output });
}

const GROWTH_LINE_LIMIT = 1000;
const NEW_FILE_LINE_LIMIT = 500;

/**
 * The size ratchet: a file already over 1,000 lines at `base` may not grow
 * any further at `head`, and a file that does not exist at `base` under its
 * own path AND was not renamed from somewhere else (a genuinely new file)
 * may not exceed 500 lines at `head`. A file at exactly 1,000 lines that
 * grows is not yet over the ratchet's line -- only a file already *over*
 * 1,000 lines is blocked from growing further, so the boundary itself can
 * still move by one line before the gate engages.
 *
 * `base` and `head` are each validated the first time the loop actually
 * needs to read something at that revision (see `validateRevision`), and the
 * result is cached so a revision already confirmed good is never re-checked.
 * An unresolvable revision fails the whole check loudly, rather than being
 * misread as "every file is absent here" -- and a file list of only exempt
 * or already-deleted-at-head files costs zero extra git calls, since neither
 * revision is ever actually read. This matters because `head`'s
 * changed-file list (`--diff-filter=ACMR`, in both wired callers) reports
 * only the NEW path of a rename -- so a plain `git show <base>:<newpath>`
 * would otherwise fail not because the revision is bad, but because the
 * path lived under a different name at `base`. Before concluding a file is
 * new, this ratchet asks git for the base/head rename pairing (see
 * `loadRenameMap`) and, when the changed path was renamed, reads the OLD
 * path's line count at `base` instead.
 *
 * Lines are read with `git show <revision>:<path>`, which works for both a
 * commit-ish `revision` (`HEAD`, a SHA) and, when `revision` is the empty
 * string, the index (`git show :path` reads the staged blob, not a commit).
 * Once the revision itself is known good, a nonzero exit from that command
 * -- "path does not exist in <revision>" -- safely means "file absent at
 * that revision": absent at `head` means the file was deleted, so there is
 * nothing to ratchet and the file is skipped; absent at `base` under both
 * its current and (if any) renamed-from path means the file is new, so the
 * new-file limit applies instead.
 *
 * `*.generated.ts` files are exempt: a generator produces their size, not a
 * change a reviewer asked for.
 *
 * @param {ReadonlyArray<string>} files
 * @param {CheckFileSizesOptions} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function checkFileSizes(files, { cwd, run, base, head, output }) {
  /** @type {Map<string, boolean>} Revision string -> already-validated result. */
  const validRevisions = new Map();
  async function ensureValidRevision(revision, label) {
    if (revision === "") return true;
    const cached = validRevisions.get(revision);
    if (cached !== undefined) return cached;
    const valid = await validateRevision(run, cwd, revision, label, output);
    validRevisions.set(revision, valid);
    return valid;
  }

  /** @type {ReadonlyMap<string, string> | undefined} */
  let renameMap;
  let failed = false;

  for (const file of files) {
    if (isGeneratedFile(file)) continue;

    if (!(await ensureValidRevision(head, "head"))) return 1;
    const headLines = await countLinesAtRevision(run, cwd, head, file, output);
    if (headLines === undefined) return 1;
    if (headLines === null) continue; // deleted at head; nothing to ratchet

    if (!(await ensureValidRevision(base, "base"))) return 1;
    let baseLines = await countLinesAtRevision(run, cwd, base, file, output);
    if (baseLines === undefined) return 1;

    if (baseLines === null) {
      if (renameMap === undefined) {
        renameMap = await loadRenameMap(run, cwd, base, head, output);
        if (renameMap === undefined) return 1;
      }
      const oldPath = renameMap.get(file);
      if (oldPath !== undefined) {
        baseLines = await countLinesAtRevision(run, cwd, base, oldPath, output);
        if (baseLines === undefined) return 1;
      }
    }

    if (baseLines === null) {
      if (headLines > NEW_FILE_LINE_LIMIT) {
        output.stderr(
          `${file} is a new file at ${headLines} lines, over the ${NEW_FILE_LINE_LIMIT}-line limit for new files. Move something out.\n`,
        );
        failed = true;
      }
      continue;
    }

    if (baseLines > GROWTH_LINE_LIMIT && headLines > baseLines) {
      output.stderr(
        `${file} grew from ${baseLines} to ${headLines} lines. Files already over ${GROWTH_LINE_LIMIT} lines cannot grow. Move something out.\n`,
      );
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

function isGeneratedFile(file) {
  return file.endsWith(".generated.ts");
}

/**
 * Confirms `revision` is a real, resolvable commit before the ratchet reads
 * anything at it. The empty string is git's own syntax (used as
 * `${revision}:${path}`) for reading the index rather than a commit, so it
 * is always valid and never sent to `git rev-parse`.
 *
 * Without this check, a bad revision and a merely-absent path are the same
 * thing to `git show`'s exit code (both nonzero), so `countLinesAtRevision`
 * would misread "the revision itself doesn't exist" as "this file is new"
 * or "this file was deleted" -- a broken ratchet reporting success. Same
 * idiom as `resolveCommitRef` in `scripts/check-changed-source.mjs`.
 *
 * @returns {Promise<boolean>} Whether `revision` resolves. `false` means an
 *   explanatory message has already gone to `output`.
 */
async function validateRevision(run, cwd, revision, label, output) {
  if (revision === "") return true;

  const result = await execute(
    run,
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    cwd,
    output,
  );
  if (result === undefined) return false; // execute() already reported the crash
  if (!hasExit(result, 0)) {
    output.stderr(
      `git could not resolve the ${label} revision "${revision}" for the file-size ratchet (status=${String(result.status)}).\n`,
    );
    if (result.stderr.length > 0) output.stderr(result.stderr);
    return false;
  }
  return true;
}

/**
 * Maps each renamed file's NEW path (at `head`) to its OLD path (at `base`),
 * across the whole `base`..`head` change, so the ratchet can find a renamed
 * file's line count at `base` even though the changed-file list (built with
 * `--diff-filter=ACMR`) only ever names the new path.
 *
 * Deliberately runs with no pathspec: filtering `git diff` to just the new
 * path hides the corresponding deletion from git's rename pairing, which
 * then reports a plain rename as an "A" (added) status instead of "R" --
 * silently reintroducing the same bug this function exists to fix. Scanning
 * the whole diff once and caching the result costs one extra git call no
 * matter how many files need a rename lookup.
 *
 * @returns {Promise<ReadonlyMap<string, string> | undefined>} `undefined`
 *   means the git command failed, already reported to `output`.
 */
async function loadRenameMap(run, cwd, base, head, output) {
  const args =
    head === ""
      ? ["diff", "--cached", "--name-status", "-M", "-z", base]
      : ["diff", "--name-status", "-M", "-z", base, head];
  const result = await execute(run, "git", args, cwd, output);
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    const headLabel = head === "" ? "the index" : `"${head}"`;
    output.stderr(
      `git could not check for renames between "${base}" and ${headLabel} (status=${String(result.status)}).\n`,
    );
    if (result.stderr.length > 0) output.stderr(result.stderr);
    return undefined;
  }
  return parseRenameMap(result.stdout);
}

/** Parses `git diff --name-status -M -z` output into a new-path -> old-path map. */
function parseRenameMap(stdout) {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const map = new Map();
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    if (status.startsWith("R")) {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (oldPath !== undefined && newPath !== undefined) {
        map.set(newPath, oldPath);
      }
      index += 3;
    } else {
      index += 2; // status + one path
    }
  }
  return map;
}

/**
 * @returns {Promise<number | null | undefined>} The line count, `null` if
 *   the file does not exist at `revision`, or `undefined` if the `git show`
 *   command itself could not be run (a crash, reported by `execute`).
 */
async function countLinesAtRevision(run, cwd, revision, path, output) {
  const result = await execute(
    run,
    "git",
    ["show", `${revision}:${path}`],
    cwd,
    output,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) return null;
  return countLines(result.stdout);
}

function countLines(content) {
  if (content === "") return 0;
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

async function runSourceQualityChecks(
  files,
  { cwd, run, fileExists = defaultFileExists, output },
) {
  const oxfmt = await pinnedTool("oxfmt", cwd, fileExists, output);
  if (oxfmt === undefined) return 1;
  const oxlint = await pinnedTool("oxlint", cwd, fileExists, output);
  if (oxlint === undefined) return 1;

  const formatter = await execute(
    run,
    oxfmt,
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
    oxlint,
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
 */
async function pinnedTool(name, cwd, fileExists, output) {
  const path = resolve(cwd, "node_modules", ".bin", name);
  if (await fileExists(path)) return path;
  output.stderr(
    `${name} is not installed at node_modules/.bin/${name}. Run pnpm install.\n` +
      `The commit gate uses this repository's pinned tools, never a copy on PATH.\n`,
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
