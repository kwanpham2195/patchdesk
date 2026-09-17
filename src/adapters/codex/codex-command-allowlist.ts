import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { casesHandled } from "../../domain/result";
import { isPathContained } from "../storage/path-containment";

const MAX_COMMAND_CHARS = 4_096;

/** Shells Codex wraps a command in; any other interpreter path is declined. */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  "/bin/zsh",
  "/bin/bash",
  "/bin/sh",
]);
const SHELL_SCRIPT_FLAGS: ReadonlySet<string> = new Set(["-lc", "-c"]);

// The characters the `shlex` crate's `try_join` leaves unquoted (shlex 1.3.0 `unquoted_ok`).
const SHLEX_UNQUOTED = /^[A-Za-z0-9+\-./:@\]_]$/u;
// Unquoted characters zsh gives no meaning inside a word; `~` and `^` are absent because EXTENDED_GLOB makes them glob operators.
const SCRIPT_UNQUOTED = /^[A-Za-z0-9_./:,@%+=-]$/u;
const COUNT = /^[0-9]{1,9}$/u;
const SED_PRINT_RANGE = /^[0-9]{1,9}(?:,[0-9]{1,9})?p$/u;
const GIT_REVISION = /^[A-Za-z0-9_][A-Za-z0-9_.@^~:/-]*$/u;

/** How one allowlisted executable reads its non-flag arguments. */
type PositionalRule =
  | "none"
  | "paths"
  | "pattern_then_paths"
  | "sed_script_then_paths"
  | "paths_then_expression"
  | "git_revisions_and_paths";

type CommandSpec = {
  readonly booleanFlags: ReadonlySet<string>;
  readonly countFlags: ReadonlySet<string>;
  readonly textFlags: ReadonlySet<string>;
  readonly positionals: PositionalRule;
  readonly requiresPath: boolean;
  /** `find` spells its predicates with one dash, so they never combine like `-rn`. */
  readonly combinesShortFlags: boolean;
  /** Flags after which every positional is a path rather than a search pattern. */
  readonly patternFlags: ReadonlySet<string>;
  /** `git log -5` style counts. */
  readonly acceptsDashCount: boolean;
};

function spec(fields: {
  readonly booleanFlags?: string;
  readonly countFlags?: string;
  readonly textFlags?: string;
  readonly patternFlags?: string;
  readonly positionals: PositionalRule;
  readonly requiresPath?: boolean;
  readonly combinesShortFlags?: boolean;
  readonly acceptsDashCount?: boolean;
}): CommandSpec {
  const words = (list: string | undefined): ReadonlySet<string> =>
    new Set(list?.split(" ").filter((word) => word.length > 0));
  return {
    booleanFlags: words(fields.booleanFlags),
    countFlags: words(fields.countFlags),
    textFlags: words(fields.textFlags),
    patternFlags: words(fields.patternFlags),
    positionals: fields.positionals,
    requiresPath: fields.requiresPath ?? false,
    combinesShortFlags: fields.combinesShortFlags ?? true,
    acceptsDashCount: fields.acceptsDashCount ?? false,
  };
}

/**
 * Every executable and flag a Codex Insight run may use. Anything absent is
 * declined, which is how `sed -i`, `rg --pre`, `rg -z`, `find -exec`,
 * `find -delete`, `git -c`, `git --output`, and `git --ext-diff` stay out.
 */
const READ_ONLY_COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  ["pwd", spec({ positionals: "none" })],
  [
    "cat",
    spec({ booleanFlags: "-n", positionals: "paths", requiresPath: true }),
  ],
  [
    "head",
    spec({
      countFlags: "-n -c",
      positionals: "paths",
      requiresPath: true,
    }),
  ],
  [
    "tail",
    spec({
      countFlags: "-n -c",
      positionals: "paths",
      requiresPath: true,
    }),
  ],
  [
    "wc",
    spec({
      booleanFlags: "-l -c -w -m",
      positionals: "paths",
      requiresPath: true,
    }),
  ],
  [
    "sed",
    spec({
      booleanFlags: "-n",
      positionals: "sed_script_then_paths",
      requiresPath: true,
    }),
  ],
  [
    "grep",
    spec({
      // `-R` is absent because it follows symlinks out of the worktree.
      booleanFlags: "-n -i -r -l -L -c -w -x -F -E -v -H -h -s -I -o",
      countFlags: "-A -B -C -m --max-count",
      textFlags: "-e --regexp --include --exclude --exclude-dir",
      patternFlags: "-e --regexp",
      positionals: "pattern_then_paths",
    }),
  ],
  [
    "rg",
    spec({
      booleanFlags:
        "-n -N -i -S -s -F -w -x -v -l -c -o -H -I --files --files-with-matches --count --hidden --no-ignore --line-number --no-heading --heading --column --fixed-strings --ignore-case --smart-case --word-regexp --invert-match --only-matching --with-filename --no-filename --no-messages",
      countFlags:
        "-A -B -C -m -d --max-count --context --before-context --after-context --max-depth",
      textFlags: "-g --glob --iglob -t --type -T --type-not -e --regexp",
      patternFlags: "-e --regexp --files",
      positionals: "pattern_then_paths",
    }),
  ],
  [
    "find",
    spec({
      booleanFlags: "-print -o -or -a -and -not",
      countFlags: "-maxdepth -mindepth",
      textFlags: "-name -iname -path -ipath -type",
      positionals: "paths_then_expression",
      requiresPath: true,
      combinesShortFlags: false,
    }),
  ],
  [
    "git",
    spec({
      booleanFlags:
        "-p -s -b -M -w --patch --no-patch --stat --shortstat --numstat --summary --name-only --name-status --oneline --short --branch --porcelain --cached --staged --merge-base --no-color --graph --decorate --no-decorate --abbrev-commit --first-parent --no-merges --reverse --all --find-renames --ignore-all-space --word-diff --no-ext-diff --no-textconv --show-toplevel --abbrev-ref --verify --others --exclude-standard --modified --deleted",
      countFlags: "-n -U --max-count --unified --skip",
      textFlags: "--format --pretty --since --until --author --diff-filter",
      positionals: "git_revisions_and_paths",
      acceptsDashCount: true,
    }),
  ],
]);

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "show",
  "diff",
  "status",
  "log",
  "ls-files",
  "rev-parse",
]);

/** Validates that a path is inside the represented worktree without following an escape. */
export async function isPathInsideWorktree(
  worktreePath: string,
  candidatePath: string,
): Promise<boolean> {
  if (isAbsolute(candidatePath) === false && candidatePath.includes(".."))
    return false;
  const [worktree, candidate] = await Promise.all([
    realpath(worktreePath),
    realpath(candidatePath),
  ]).catch(() => ["", ""] as const);
  if (worktree.length === 0 || candidate.length === 0) return false;
  return isPathContained(worktree, candidate);
}

/**
 * Decides whether a Codex command approval request names a read-only
 * inspection inside `worktreePath`. `command` is Codex's `shlex_join` of the
 * argv; a `/bin/zsh -lc` script is accepted only when it is plain words joined
 * by ` && `, and every segment must pass on its own.
 */
export async function isReadOnlyCommand(
  command: string,
  worktreePath: string,
): Promise<boolean> {
  if (
    command.length === 0 ||
    command.length > MAX_COMMAND_CHARS ||
    /[`$\n\r]/u.test(command)
  )
    return false;
  const argv = splitShlexJoinedCommand(command);
  if (argv === undefined) return false;
  const segments = commandSegments(argv);
  if (segments === undefined) return false;
  for (const segment of segments)
    if (!(await isReadOnlySegment(segment, worktreePath))) return false;
  return true;
}

function commandSegments(
  argv: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> | undefined {
  const [executable, flag, script, ...rest] = argv;
  if (executable === undefined || !SHELL_WRAPPERS.has(executable))
    return [argv];
  if (
    flag === undefined ||
    !SHELL_SCRIPT_FLAGS.has(flag) ||
    script === undefined ||
    rest.length > 0
  )
    return undefined;
  return splitShellScript(script);
}

/** Inverts `shlex::try_join`, declining any spelling that crate would not produce. */
function splitShlexJoinedCommand(
  command: string,
): ReadonlyArray<string> | undefined {
  const words: string[] = [];
  let index = 0;
  while (index < command.length) {
    let word = "";
    const start = index;
    while (index < command.length && command[index] !== " ") {
      const character = command[index] ?? "";
      if (character === "'") {
        const close = command.indexOf("'", index + 1);
        if (close === -1) return undefined;
        const quoted = command.slice(index + 1, close);
        if (/[\\^]/u.test(quoted)) return undefined;
        word += quoted;
        index = close + 1;
      } else if (character === '"') {
        index += 1;
        for (;;) {
          const next = command[index];
          if (next === undefined) return undefined;
          index += 1;
          if (next === '"') break;
          if (next === "\\") {
            const escaped = command[index];
            if (escaped !== '"' && escaped !== "\\") return undefined;
            word += escaped;
            index += 1;
          } else if (next === "!" || next === "^") return undefined;
          else word += next;
        }
      } else if (SHLEX_UNQUOTED.test(character)) {
        word += character;
        index += 1;
      } else return undefined;
    }
    if (index === start) return undefined;
    words.push(word);
    if (index < command.length) {
      index += 1;
      if (index === command.length) return undefined;
    }
  }
  return words;
}

/**
 * Splits a shell script into ` && `-joined word lists. It accepts only literal
 * words, single-quoted text, and double-quoted text without `$`, backquote, or
 * backslash, so no expansion, redirection, pipe, glob, or substitution passes.
 */
function splitShellScript(
  script: string,
): ReadonlyArray<ReadonlyArray<string>> | undefined {
  const segments: string[][] = [[]];
  let index = 0;
  while (index < script.length) {
    const current = segments.at(-1) ?? [];
    const character = script[index];
    if (character === " " || character === "\t") {
      index += 1;
      continue;
    }
    if (script.startsWith("&&", index)) {
      const after = script[index + 2];
      if (current.length === 0 || (after !== " " && after !== "\t"))
        return undefined;
      segments.push([]);
      index += 2;
      continue;
    }
    let word = "";
    while (
      index < script.length &&
      script[index] !== " " &&
      script[index] !== "\t"
    ) {
      const next = script[index] ?? "";
      if (next === "'" || next === '"') {
        const close = script.indexOf(next, index + 1);
        if (close === -1) return undefined;
        const quoted = script.slice(index + 1, close);
        // zsh's RC_QUOTES reads `''` inside single quotes as a quote.
        if (next === "'" && script[close + 1] === "'") return undefined;
        if (next === '"' && /[\\]/u.test(quoted)) return undefined;
        word += quoted;
        index = close + 1;
        continue;
      }
      if (!SCRIPT_UNQUOTED.test(next)) return undefined;
      // zsh expands `=cmd` to the command's path.
      if (next === "=" && word.length === 0) return undefined;
      word += next;
      index += 1;
    }
    current.push(word);
  }
  const last = segments.at(-1);
  if (last === undefined || last.length === 0) return undefined;
  return segments;
}

async function isReadOnlySegment(
  tokens: ReadonlyArray<string>,
  worktreePath: string,
): Promise<boolean> {
  if (
    tokens.some(
      (token) =>
        token.length === 0 ||
        token.startsWith("/") ||
        token.split("/").includes(".."),
    )
  )
    return false;
  const [executable, ...rest] = tokens;
  const commandSpec =
    executable === undefined ? undefined : READ_ONLY_COMMANDS.get(executable);
  if (commandSpec === undefined) return false;
  let args: ReadonlyArray<string> = rest;
  if (executable === "git") {
    if (args[0] === "--no-pager") args = args.slice(1);
    if (!GIT_READ_SUBCOMMANDS.has(args[0] ?? "")) return false;
    args = args.slice(1);
  }
  const parsed = parseArguments(args, commandSpec);
  if (parsed === undefined) return false;
  return await arePositionalsReadOnly(parsed, commandSpec, worktreePath);
}

type ParsedArguments = {
  readonly positionals: ReadonlyArray<{
    readonly value: string;
    readonly afterSeparator: boolean;
  }>;
  readonly flags: ReadonlySet<string>;
};

function parseArguments(
  args: ReadonlyArray<string>,
  commandSpec: CommandSpec,
): ParsedArguments | undefined {
  const positionals: Array<ParsedArguments["positionals"][number]> = [];
  const flags = new Set<string>();
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (afterSeparator || !token.startsWith("-") || token === "-") {
      if (commandSpec.positionals === "paths_then_expression" && flags.size > 0)
        return undefined;
      positionals.push({ value: token, afterSeparator });
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const exact = !commandSpec.combinesShortFlags || token.startsWith("--");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (exact && equals === -1 && commandSpec.booleanFlags.has(name)) {
      flags.add(name);
      continue;
    }
    if (commandSpec.acceptsDashCount && /^-[0-9]{1,9}$/u.test(token)) continue;
    const valueFlag = exact ? name : token.slice(0, 2);
    const isCount = commandSpec.countFlags.has(valueFlag);
    if (isCount || commandSpec.textFlags.has(valueFlag)) {
      const attached = exact
        ? equals === -1
          ? undefined
          : token.slice(equals + 1)
        : token.length > 2
          ? token.slice(2)
          : undefined;
      let value = attached;
      if (value === undefined) {
        index += 1;
        value = args[index];
      }
      if (value === undefined || value.length === 0) return undefined;
      if (isCount && !COUNT.test(value)) return undefined;
      flags.add(valueFlag);
      continue;
    }
    if (exact) return undefined;
    for (const letter of token.slice(1)) {
      if (!commandSpec.booleanFlags.has(`-${letter}`)) return undefined;
      flags.add(`-${letter}`);
    }
  }
  return { positionals, flags };
}

async function arePositionalsReadOnly(
  { positionals, flags }: ParsedArguments,
  commandSpec: CommandSpec,
  worktreePath: string,
): Promise<boolean> {
  const inside = (token: string): Promise<boolean> =>
    isPathInsideWorktree(worktreePath, join(worktreePath, token));
  let paths = positionals.map(({ value }) => value);
  switch (commandSpec.positionals) {
    case "none":
      return positionals.length === 0 && flags.size === 0;
    case "paths":
    case "paths_then_expression":
      break;
    case "pattern_then_paths": {
      if (![...flags].some((flag) => commandSpec.patternFlags.has(flag))) {
        if (paths.length === 0) return false;
        paths = paths.slice(1);
      }
      break;
    }
    case "sed_script_then_paths": {
      const [script, ...files] = paths;
      if (script === undefined || !SED_PRINT_RANGE.test(script)) return false;
      paths = files;
      break;
    }
    case "git_revisions_and_paths":
      for (const { value, afterSeparator } of positionals) {
        if (await inside(value)) continue;
        if (afterSeparator || !GIT_REVISION.test(value)) return false;
      }
      return true;
    default:
      return casesHandled(commandSpec.positionals);
  }
  if (commandSpec.requiresPath && paths.length === 0) return false;
  for (const path of paths) if (!(await inside(path))) return false;
  return true;
}
