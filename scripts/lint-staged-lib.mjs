import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { countLines, isImportSpecifierOnlyGrowth } from "./file-growth-lib.mjs";
import {
  defaultFileExists,
  execute,
  hasExit,
  pinnedTool,
  replay,
} from "./gate-command-lib.mjs";

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
 * @typedef {import("./gate-command-lib.mjs").RunCommand} RunCommand
 */

/**
 * @typedef {import("./gate-command-lib.mjs").CommandOutput} CommandOutput
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
 * `head` sentinel meaning "the files as they sit on disk", for a gate that
 * runs before anything is staged (`pnpm gate:preflight`). Every other head is
 * a revision git can resolve, or `""` for the index, and neither can name the
 * working tree. A NUL byte keeps it from ever colliding with a real revision:
 * git refuses one in a ref name.
 */
export const WORKING_TREE = "\u0000worktree";

/**
 * @typedef {(path: string) => Promise<string | null>} ReadWorkingFile
 */

/**
 * @typedef {LintStagedOptions & {
 *   readonly base: string;
 *   readonly head: string;
 *   readonly readWorkingFile?: ReadWorkingFile;
 *   readonly label?: string;
 *   readonly noun?: string;
 * }} CheckSourcePathsOptions
 */

/**
 * @typedef {{
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly base: string;
 *   readonly head: string;
 *   readonly readWorkingFile?: ReadWorkingFile;
 *   readonly output: CommandOutput;
 * }} CheckFileSizesOptions
 */

/**
 * Reads a working-tree file, reporting an absent one as `null` the way
 * `readAtRevision` reports a path absent at a revision.
 *
 * @type {ReadWorkingFile}
 */
async function defaultReadWorkingFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Check staged JavaScript and TypeScript files without changing the index or
 * working tree.
 *
 * The repo-wide Oxlint count ratchet does not run here: `scripts/
 * check-changed-source.mjs` (`pnpm lint:changed`) already runs it once per
 * `pnpm check`, and that is the shape CI enforces.
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

  const changedPaths = splitNullDelimitedPaths(discovered.stdout);
  const files = selectSourcePaths(changedPaths);

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

  const base = await stagedBase(run, cwd, output);
  if (base === undefined) return 1;

  if (files.length === 0) {
    output.stdout("lint-staged: no staged source files to check.\n");
  } else {
    // `head` is "" (no revision before the colon), which is git's own syntax
    // for reading a path out of the index rather than a commit. The staged
    // content is what is about to be committed, and it is not yet reachable
    // by any commit-ish, so the index is the only right place to read it
    // from. The unstaged-change guard above proves the working tree agrees.
    const sourceResult = await checkSourcePaths(files, {
      cwd,
      run,
      fileExists,
      output,
      base,
      head: "",
    });
    if (sourceResult !== 0) return sourceResult;
  }

  return 0;
}

/**
 * The revision the staged change is measured against: `HEAD` normally, and
 * git's empty tree when the branch is unborn.
 *
 * A pre-commit hook runs before the commit exists, so on the very first
 * commit in a repository there is no `HEAD` at all -- and no `HEAD~1` either,
 * which is why the gate never asks for one. Resolving to the empty tree makes
 * every staged file read as new (the 500-line new-file limit applies) instead
 * of wedging the first commit on "git could not resolve the base revision".
 *
 * The empty tree's object id is asked of git rather than hard-coded, because
 * a SHA-256 repository has a different one.
 *
 * @returns {Promise<string | undefined>} `undefined` means git itself failed,
 *   already reported to `output`.
 */
async function stagedBase(run, cwd, output) {
  const head = await execute(
    run,
    "git",
    // `--quiet` must come BEFORE `--end-of-options`: everything after that
    // marker is read as a revision, so the other order asks git to resolve a
    // revision literally named "--quiet" and always fails.
    ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"],
    cwd,
    output,
  );
  if (head === undefined) return undefined;
  if (hasExit(head, 0)) return "HEAD";

  const empty = await execute(
    run,
    "git",
    ["hash-object", "-t", "tree", "/dev/null"],
    cwd,
    output,
  );
  if (empty === undefined) return undefined;
  if (!hasExit(empty, 0)) {
    output.stderr(
      "HEAD does not resolve and git could not name its empty tree, so the " +
        "staged change has nothing to be compared against.\n",
    );
    if (empty.stderr.length > 0) output.stderr(empty.stderr);
    return undefined;
  }
  const objectId = empty.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(objectId)) {
    output.stderr("git returned an invalid empty-tree object id.\n");
    return undefined;
  }
  return objectId;
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
  {
    cwd,
    run,
    fileExists = defaultFileExists,
    readWorkingFile = defaultReadWorkingFile,
    label = "lint-staged",
    noun = "staged source",
    output,
    base,
    head,
  },
) {
  const files = await selectSourceFiles(paths, cwd, fileExists);
  if (files.length === 0) {
    output.stdout(`${label}: no source files to check.\n`);
    return 0;
  }

  const sizeResult = await checkFileSizes(files, {
    cwd,
    run,
    base,
    head,
    readWorkingFile,
    output,
  });
  if (sizeResult !== 0) return sizeResult;

  return runSourceQualityChecks(files, {
    cwd,
    run,
    fileExists,
    label,
    noun,
    output,
  });
}

const FILE_LINE_CEILING = 1000;
const NEW_FILE_LINE_LIMIT = 500;

/**
 * The size ratchet. Two rules:
 *
 * 1. **No file may grow while it is over 1,000 lines at `head`.** A file at
 *    999 lines cannot become 1,001, and a file already at 3,020 cannot
 *    become 3,021. The ceiling is absolute, so it composes across commits:
 *    forty commits of five lines each hit it at exactly the same place one
 *    commit of two hundred does.
 * 2. **A genuinely new file may not exceed 500 lines at `head`** -- one that
 *    does not exist at `base` under its own path AND was not renamed from
 *    somewhere else.
 *
 * Rule 1 replaced an earlier `base > 1,000 && head > base`, which left a
 * blind band: a file between 501 and 999 lines could grow freely, and the
 * commit that carried it over the line could carry it as far as it liked.
 * Measured over this repository's own history, that is not hypothetical --
 * `tests/scripts/lint-staged.test.ts` went 763 -> 1,111 in one commit and
 * `tests/services/review-workbench-projection.test.ts` went 981 -> 1,097 in
 * another. Both are now over the ceiling and frozen there for good. Rule 1
 * would have stopped each of them at the boundary instead, and it is the
 * only growth it would have stopped in 39 commits that touched source.
 *
 * Growth that is nothing but added import specifiers is exempt (see
 * `isImportSpecifierOnlyGrowth`, `scripts/file-growth-lib.mjs`). It is
 * exempt from rule 1 only: a new file has no base to compare against.
 *
 * `base` and `head` are each validated the first time the loop actually
 * needs to read something at that revision (see `validateRevision`), and the
 * result is cached so a revision already confirmed good is never re-checked.
 * An unresolvable revision fails the whole check loudly, rather than being
 * misread as "every file is absent here" -- and a file list of only exempt
 * or already-deleted-at-head files costs zero extra git calls, since neither
 * revision is ever actually read. This matters because `head`'s
 * changed-file list (`--diff-filter=ACDMR`, in both wired callers) reports
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
export async function checkFileSizes(
  files,
  { cwd, run, base, head, readWorkingFile = defaultReadWorkingFile, output },
) {
  /** @type {Map<string, boolean>} Revision string -> already-validated result. */
  const validRevisions = new Map();
  async function ensureValidRevision(revision, label) {
    if (revision === "" || revision === WORKING_TREE) return true;
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
    const headContent = await readAtRevision(
      run,
      cwd,
      head,
      file,
      readWorkingFile,
      output,
    );
    if (headContent === undefined) return 1;
    if (headContent === null) continue; // deleted at head; nothing to ratchet

    if (!(await ensureValidRevision(base, "base"))) return 1;
    let baseContent = await readAtRevision(
      run,
      cwd,
      base,
      file,
      readWorkingFile,
      output,
    );
    if (baseContent === undefined) return 1;

    if (baseContent === null) {
      if (renameMap === undefined) {
        renameMap = await loadRenameMap(run, cwd, base, head, output);
        if (renameMap === undefined) return 1;
      }
      const oldPath = renameMap.get(file);
      if (oldPath !== undefined) {
        baseContent = await readAtRevision(
          run,
          cwd,
          base,
          oldPath,
          readWorkingFile,
          output,
        );
        if (baseContent === undefined) return 1;
      }
    }

    const headLines = countLines(headContent);

    if (baseContent === null) {
      if (headLines > NEW_FILE_LINE_LIMIT) {
        output.stderr(
          `${file} is a new file at ${headLines} lines, over the ${NEW_FILE_LINE_LIMIT}-line limit for new files. Move something out.\n`,
        );
        failed = true;
      }
      continue;
    }

    const baseLines = countLines(baseContent);
    if (headLines <= FILE_LINE_CEILING || headLines <= baseLines) continue;
    if (isImportSpecifierOnlyGrowth(baseContent, headContent)) continue;

    output.stderr(
      `${file} grew from ${baseLines} to ${headLines} lines, past the ${FILE_LINE_CEILING}-line ceiling. No file may grow beyond it. Move something out.\n`,
    );
    failed = true;
  }

  return failed ? 1 : 0;
}

function isGeneratedFile(file) {
  return file.endsWith(".generated.ts");
}

/**
 * Confirms `revision` is a real, resolvable tree before the ratchet reads
 * anything at it. The empty string is git's own syntax (used as
 * `${revision}:${path}`) for reading the index rather than a commit, so it
 * is always valid and never sent to `git rev-parse`.
 *
 * Resolution asks for `^{tree}`, not `^{commit}`, because `git show
 * <revision>:<path>` is a tree lookup and every caller only ever does that.
 * A commit-ish resolves to its tree, so `HEAD` and a SHA still pass -- and so
 * does the empty tree `stagedBase` returns on an unborn branch, which
 * `^{commit}` would reject.
 *
 * Without this check, a bad revision and a merely-absent path are the same
 * thing to `git show`'s exit code (both nonzero), so `readAtRevision`
 * would misread "the revision itself doesn't exist" as "this file is new"
 * or "this file was deleted" -- a broken ratchet reporting success. Same
 * idiom as `resolveCommitRef` in `scripts/quality-ratchet-lib.mjs`.
 *
 * @returns {Promise<boolean>} Whether `revision` resolves. `false` means an
 *   explanatory message has already gone to `output`.
 */
async function validateRevision(run, cwd, revision, label, output) {
  if (revision === "" || revision === WORKING_TREE) return true;

  const result = await execute(
    run,
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{tree}`],
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
 * `--diff-filter=ACDMR`) only ever names the new path.
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
  const args = renameDiffArgs(base, head);
  const result = await execute(run, "git", args, cwd, output);
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    const headLabel = describeHead(head);
    output.stderr(
      `git could not check for renames between "${base}" and ${headLabel} (status=${String(result.status)}).\n`,
    );
    if (result.stderr.length > 0) output.stderr(result.stderr);
    return undefined;
  }
  return parseRenameMap(result.stdout);
}

/**
 * The `git diff` that pairs renames between `base` and each shape of head:
 * the index (`""`), the working tree (`WORKING_TREE`), or a commit-ish.
 *
 * @param {string} base
 * @param {string} head
 * @returns {ReadonlyArray<string>}
 */
function renameDiffArgs(base, head) {
  if (head === "")
    return ["diff", "--cached", "--name-status", "-M", "-z", base];
  if (head === WORKING_TREE) return ["diff", "--name-status", "-M", "-z", base];
  return ["diff", "--name-status", "-M", "-z", base, head];
}

/**
 * @param {string} head
 * @returns {string}
 */
function describeHead(head) {
  if (head === "") return "the index";
  if (head === WORKING_TREE) return "the working tree";
  return `"${head}"`;
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
 * The file's whole content at `revision`. The ratchet needs the text, not
 * just a count: the import-specifier exemption has to see which lines the
 * growth is made of.
 *
 * `WORKING_TREE` is not a revision git can read, so it is answered from disk
 * instead. Everything after that point is identical: an absent file is `null`
 * either way, so the ratchet's new-file and deleted-at-head branches do not
 * need to know which side they were told from.
 *
 * @param {ReadWorkingFile} readWorkingFile
 * @returns {Promise<string | null | undefined>} The content, `null` if the
 *   file does not exist at `revision`, or `undefined` if the `git show`
 *   command itself could not be run (a crash, reported by `execute`).
 */
async function readAtRevision(
  run,
  cwd,
  revision,
  path,
  readWorkingFile,
  output,
) {
  if (revision === WORKING_TREE) return readWorkingFile(resolve(cwd, path));
  const result = await execute(
    run,
    "git",
    ["show", `${revision}:${path}`],
    cwd,
    output,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) return null;
  return result.stdout;
}

async function runSourceQualityChecks(
  files,
  {
    cwd,
    run,
    fileExists = defaultFileExists,
    label = "lint-staged",
    noun = "staged source",
    output,
  },
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

  output.stdout(`${label}: checked ${files.length} ${noun} file(s).\n`);
  return 0;
}

/**
 * The staged change's paths. `D` is in the filter because deleting
 * `.oxlintrc.json`, or a rule file under `tools/oxlint/`, is a configuration
 * change like any other and the count ratchet's rule 2 has to see it. The
 * size ratchet consumes the same list and is unharmed: `selectSourceFiles`
 * drops any path that is not on disk, and `checkFileSizes` skips a file that
 * is absent at `head`, so a deleted file is never read for a line count.
 * `U` (unmerged) stays out: a conflicted path is not yet a change.
 */
function discoveryArgs() {
  return ["diff", "--cached", "--name-only", "--diff-filter=ACDMR", "-z"];
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

function reportUnexpectedExit(output, command, result) {
  output.stderr(
    `${command} failed (status=${String(result.status)}, signal=${String(result.signal)}).\n`,
  );
}

function formatPaths(files) {
  return files.map((file) => JSON.stringify(file)).join(" ");
}
