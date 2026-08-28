/**
 * The fixture every `lintStaged` test drives the gate through.
 *
 * It lives here rather than in one of the test files because two of them
 * need it: `lint-staged.test.ts` for the discovery, ordering, partial-staging
 * and size-ratchet cases, and `lint-count-ratchet.test.ts` for the Oxlint
 * finding-count ratchet. Copying it would let the two copies drift, and a
 * gate test whose fixture no longer matches the gate is the failure this
 * whole file is built to avoid.
 */

type CommandCall = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
};

export type CommandResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

type HarnessOptions = {
  readonly stagedOutput?: string;
  readonly existingPaths?: ReadonlySet<string>;
  readonly partiallyStagedPaths?: ReadonlySet<string>;
  readonly toolResults?: ReadonlyMap<string, CommandResult>;
  readonly rejectedCommand?: string;
  readonly installedTools?: ReadonlySet<string>;
  /**
   * `git show` result keyed by its `<revision>:<path>` argument, for the
   * size ratchet. When this is left unset entirely, any `git show` call
   * gets `DEFAULT_SHOW_CONTENT` (a few short lines), which never trips the
   * ratchet, so tests that are not about file sizes do not need to know it
   * runs at all. Once a test configures ANY spec here, every other spec the
   * ratchet reads must be configured too -- an unlisted spec then reports
   * "absent", the same as a real revision that does not have that path.
   * This mirrors reality and keeps an unconfigured spec from silently
   * masking a bug (see the size-ratchet rename tests below).
   */
  readonly showResults?: ReadonlyMap<string, CommandResult>;
  /**
   * The base/head rename pairing the size ratchet asks for whenever a
   * changed path is absent under its own name at `base` (see
   * `loadRenameMap` in `lint-staged-lib.mjs`). Keyed by the path's name at
   * `head`, valued by its name at `base`. Defaults to no renames.
   */
  readonly renameMap?: ReadonlyMap<string, string>;
  /**
   * `lint-baseline.json`'s `findings` value, as the count ratchet reads it
   * out of the index (`git show :lint-baseline.json`). Defaults to 0, which
   * matches the default repo-wide diagnostic count, so tests that are not
   * about the ratchet never trip it.
   */
  readonly baselineFindings?: number;
  /** Raw indexed `lint-baseline.json` content. Overrides `baselineFindings`. */
  readonly baselineContent?: string;
  /** Raw `git show :lint-baseline.json` result. Overrides both of the above. */
  readonly baselineResult?: CommandResult;
  /** Diagnostic count the repo-wide ratchet Oxlint run reports. Defaults to 0. */
  readonly ratchetDiagnosticsCount?: number;
  /** Raw repo-wide ratchet Oxlint result. Overrides `ratchetDiagnosticsCount`. */
  readonly ratchetResult?: CommandResult;
  /** Makes `HEAD` unresolvable, the way an unborn branch does. */
  readonly unbornHead?: boolean;
};

export const cwd = "/fixture/project";

/** Git's empty tree, which `stagedBase` falls back to on an unborn branch. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const BASELINE_SPEC_SUFFIX = ":lint-baseline.json";

/**
 * Git reads EVERY argument after `--end-of-options` as a revision, so an
 * option written after that marker is not an option at all and the command
 * fails with "Needed a single revision". A stub that answers any `rev-parse`
 * with a SHA hides that, and hid it once: `--quiet` written after the marker
 * made `stagedBase` believe HEAD was unborn on every commit, which turned
 * every modified file into a "new file" for the size ratchet.
 */
function optionAfterEndOfOptions(
  args: ReadonlyArray<string>,
): CommandResult | undefined {
  const marker = args.indexOf("--end-of-options");
  if (marker === -1 || args.length - marker === 2) return undefined;
  return failure("fatal: Needed a single revision", 128);
}

/** Where the gate must find a pinned tool: never a same-named binary on PATH. */
export const pinned = (name: string): string =>
  `${cwd}/node_modules/.bin/${name}`;

/** Well under every size-ratchet limit, so unrelated tests never trip it. */
const DEFAULT_SHOW_CONTENT = "one\ntwo\nthree\n";

/**
 * Encodes a rename map into the `git diff --name-status -M -z` output the
 * size ratchet's rename lookup parses. Each entry becomes one `R100`
 * (old-path, new-path) record; an empty/absent map means "no renames",
 * matching a real diff over a change that contains none.
 */
export function renameDiffStdout(
  renameMap: ReadonlyMap<string, string> | undefined,
): string {
  if (renameMap === undefined) return "";
  let stdout = "";
  for (const [newPath, oldPath] of renameMap) {
    stdout += `R100\0${oldPath}\0${newPath}\0`;
  }
  return stdout;
}

const PINNED_TOOLS: ReadonlySet<string> = new Set([
  "node_modules/.bin/oxfmt",
  "node_modules/.bin/oxlint",
]);

export const success = (stdout = ""): CommandResult => ({
  status: 0,
  signal: null,
  stdout,
  stderr: "",
});

export const failure = (stderr: string, status = 1): CommandResult => ({
  status,
  signal: null,
  stdout: "",
  stderr,
});

export function createHarness(options: HarnessOptions = {}) {
  const calls: Array<CommandCall> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stagedOutput = options.stagedOutput ?? "src/example.ts\0";
  const existingPaths = options.existingPaths ?? new Set(["src/example.ts"]);
  const installedTools = options.installedTools ?? PINNED_TOOLS;
  const partiallyStagedPaths =
    options.partiallyStagedPaths ?? new Set<string>();
  const toolResults = options.toolResults ?? new Map<string, CommandResult>();
  const baselineResult =
    options.baselineResult ??
    success(
      options.baselineContent ??
        JSON.stringify({ findings: options.baselineFindings ?? 0 }),
    );
  const ratchetResult =
    options.ratchetResult ??
    success(
      JSON.stringify({
        diagnostics: Array.from(
          { length: options.ratchetDiagnosticsCount ?? 0 },
          () => ({}),
        ),
      }),
    );

  const run = async (
    command: string,
    args: ReadonlyArray<string>,
    commandCwd: string,
  ): Promise<CommandResult> => {
    calls.push({ command, args, cwd: commandCwd });
    if (command === "git" && args[0] === "rev-parse") {
      const badOrder = optionAfterEndOfOptions(args);
      if (badOrder !== undefined) return badOrder;
      if (options.unbornHead === true && args.includes("HEAD^{commit}"))
        return failure("fatal: Needed a single revision", 128);
      return success("deadbeef\n");
    }
    if (command === "git" && args[0] === "hash-object")
      return success(`${EMPTY_TREE}\n`);
    if (command === "git" && args[0] === "ls-files") {
      // Real `git ls-files --stage -- lint-baseline.json` prints an index
      // entry for a tracked file whether or not this change touches it, so
      // the only honest answer here is "yes, always" -- which is exactly why
      // the configuration rule cannot be built on it. Throwing keeps any
      // regression that reaches for it visible instead of letting a fake
      // "yes" or "no" decide the gate.
      throw new Error("the configuration rule must not ask git ls-files");
    }
    if (
      command === "git" &&
      args[0] === "diff" &&
      args.includes("--name-status")
    )
      return success(renameDiffStdout(options.renameMap));
    if (command === "git" && args[0] === "diff" && args[1] === "--cached")
      return success(stagedOutput);
    if (command === "git" && args[0] === "diff" && args[1] === "--quiet") {
      const path = args[args.length - 1];
      return path !== undefined && partiallyStagedPaths.has(path)
        ? failure("unstaged changes")
        : success();
    }
    if (command === "git" && args[0] === "show") {
      const spec = args[1];
      // The count ratchet's baseline read is answered before `showResults`,
      // which only ever describes source files for the size ratchet.
      if (spec !== undefined && spec.endsWith(BASELINE_SPEC_SUFFIX))
        return baselineResult;
      const configured =
        spec === undefined ? undefined : options.showResults?.get(spec);
      if (configured !== undefined) return configured;
      if (options.showResults !== undefined && options.showResults.size > 0) {
        return failure(`fatal: path '${String(spec)}' does not exist`, 128);
      }
      return success(DEFAULT_SHOW_CONTENT);
    }
    const tool = command.startsWith(`${cwd}/node_modules/.bin/`)
      ? command.slice(`${cwd}/node_modules/.bin/`.length)
      : command;
    if (options.rejectedCommand === tool) throw new Error("spawn failed");
    // The repo-wide ratchet run and the staged-file run are the same binary;
    // only `--format=json` tells them apart.
    if (tool === "oxlint" && args.includes("--format=json"))
      return ratchetResult;
    const result = toolResults.get(tool);
    return result ?? success();
  };

  return {
    calls,
    stdout,
    stderr,
    options: {
      cwd,
      run,
      fileExists: async (path: string) => {
        const relative = path.slice(cwd.length + 1);
        if (relative.startsWith("node_modules/.bin/"))
          return installedTools.has(relative);
        return existingPaths.has(path) || existingPaths.has(relative);
      },
      output: {
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
      },
    },
  };
}
