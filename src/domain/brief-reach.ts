import { changedEnclosingExports } from "./brief-reach-exports";
import type { BriefReachMention } from "./brief-reach-mentions";
import { classifyChangedPath } from "./change-scope";
import { tokenizeUnifiedPatch } from "./unified-patch";

/*
 * The Brief reader draws this block under the heading "Blast radius": what
 * depends on the changed code, one hop out, by text match.
 *
 * Nothing here asks a model for a number. A model may propose symbol names; a
 * name survives only when it is a plausible identifier that the patch changed
 * (on a changed line or around one), and the counting itself is a
 * `git grep` run by `src/services/brief-reach-service.ts`. Every rule below is
 * a text rule, so the block is labelled "text match" and never "call graph".
 */

/** A name a model may propose, or a declaration the patch itself carries. */
const REACH_IDENTIFIER_SYNTAX = /^[A-Za-z_$][\w$]*$/;
const MIN_REACH_SYMBOL_LENGTH = 2;
const MAX_REACH_SYMBOL_LENGTH = 80;
/**
 * The cap on names Patchdesk *counts*, sized so every export a PR changes
 * fits; `briefOutputSchema`'s `MAX_REACH_SYMBOLS` caps what a child proposes.
 */
const MAX_COUNTED_REACH_SYMBOLS = 20;
/** How many outside paths one symbol names before the rest become a count. */
export const MAX_REACH_OUTSIDE_PATHS = 20;

/**
 * An `export`-shaped declaration head, used for the counted names and for the
 * removed-symbol rule. Go's `func Name(` is
 * included; a Go method with a receiver (`func (r *T) Name(`) is not, because
 * its name is not the first identifier on the line.
 */
const EXPORTED_DECLARATION_SYNTAX =
  /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|const|type|interface|class)|func)\s+([A-Za-z_$][\w$]*)/;

/** One changed file, reduced to the text the Reach rules read. */
export type BriefReachFile = {
  readonly path: string;
  /** This file's added and removed line text, joined; the patch carries no more. */
  readonly changedText: string;
};

/**
 * One changed contract and where it is still named. The counts are file counts,
 * not call counts: `git grep --count` reports matches per file, and a name
 * match is not a call.
 */
export type BriefReachSymbol = {
  readonly name: string;
  readonly outsideCallerFiles: number;
  readonly outsidePaths: ReadonlyArray<string>;
  /** True when the name is also named by a file this pull request changes. */
  readonly insidePR: boolean;
  /** `new` when the patch declares the name only on added lines, so nothing outside it can depend on it yet. */
  readonly status: "new" | "changed";
} & BriefReachMentions;

/**
 * The outside lines that name a symbol, calls first, cut to the site caps;
 * `mentionCount` is every outside line before the cut. Both are absent on a
 * Brief retained before mention sites existed, which the reader draws as files.
 */
type BriefReachMentions = {
  readonly mentions?: ReadonlyArray<BriefReachMention>;
  readonly mentionCount?: number;
};

/** One changed file this pull request's own tests never mention. */
export type BriefReachUntested = {
  readonly path: string;
  readonly reason: "no_test_in_pr";
};

/** One removed declaration whose name still appears outside the diff. */
export type BriefReachRemoved = {
  readonly name: string;
  readonly paths: ReadonlyArray<string>;
} & BriefReachMentions;

/**
 * The Reach block. `method` and `hop` are stored beside the counts so the
 * reader's footer states how the numbers were made without inferring it.
 */
export type BriefReach = {
  readonly symbols: ReadonlyArray<BriefReachSymbol>;
  readonly untested: ReadonlyArray<BriefReachUntested>;
  readonly removedStillReferenced: ReadonlyArray<BriefReachRemoved>;
  readonly method: "text_match";
  readonly hop: 1;
};

/** Why a Brief carries no Reach block; stored in its place so the reader can say so. */
export type BriefReachUnavailableReason =
  | "worktree_unavailable"
  | "head_mismatch"
  | "search_failed"
  | "timed_out";

/** Extensions the No matching test row reads as source code. */
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".ex",
  ".exs",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".php",
  ".prisma",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

function isSourcePath(path: string): boolean {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** A generated or hand-written test double: nobody writes a test for a mock. */
function isTestDoublePath(path: string): boolean {
  const segments = normalizeReachPath(path).split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) => /^(?:mocks?|fakes?|stubs?)$/.test(segment)) ||
    /^mock_|_mock\.|\.mock\./.test(name)
  );
}

/**
 * The symbol names Patchdesk will count callers for, in cap order: every
 * `export`-shaped name declared on a changed line, then every exported
 * top-level declaration enclosing a changed line at the head (`headLines`,
 * keyed by path), then proposed names a changed line carries. The first two
 * make the block independent of which names a model happened to list; a
 * proposed name the diff never touched names something the model did not read.
 */
export function candidateReachSymbols(
  patch: string,
  proposed: ReadonlyArray<string>,
  headLines: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> {
  const changed = changedLineText(patch, "both");
  const kept = [...declaredNames(patch, "both")];
  const seen = new Set(kept);
  for (const name of changedEnclosingExports(patch, headLines)) {
    if (!isReachIdentifier(name) || seen.has(name)) continue;
    seen.add(name);
    kept.push(name);
  }
  for (const name of proposed) {
    const trimmed = name.trim();
    if (!isReachIdentifier(trimmed) || seen.has(trimmed)) continue;
    if (!appearsAsWholeWord(changed, trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return kept.slice(0, MAX_COUNTED_REACH_SYMBOLS);
}

/**
 * Declarations the patch removed and never added back. A name that reappears on
 * an added line was moved or rewritten, not removed, so it is not one of these.
 */
export function removedSymbols(patch: string): ReadonlyArray<string> {
  const added = changedLineText(patch, "added");
  return declaredNames(patch, "removed")
    .filter((name) => !appearsAsWholeWord(added, name))
    .slice(0, MAX_COUNTED_REACH_SYMBOLS);
}

/**
 * Names the patch declares on added lines and never on removed ones. Any other
 * counted name existed before this pull request, so it reads as `changed`.
 */
export function newlyDeclaredNames(patch: string): ReadonlySet<string> {
  const before = new Set(declaredNames(patch, "removed"));
  return new Set(
    declaredNames(patch, "added").filter((name) => !before.has(name)),
  );
}

/**
 * Changed files no changed test covers, by three rules, each tried before the
 * next: (a) name -- a changed test file's stem, with case, `-`, `_`, and `.`
 * folded out, equals the production file's folded stem or that stem plus
 * `test`/`spec`, so `update-plan.go` reads as tested by a changed
 * `update_plan_test.go` even though the two spell the same name with a
 * different separator; (b) directory -- a changed test file sits in the
 * production file's own directory (Go's same-package `_test.go` siblings) or
 * in a `__tests__` folder directly under it, which is what marks
 * `generate-suggestion.go` tested by an unrelated `list_customers_test.go`
 * sitting beside it; (c) mention -- the same folded text falls somewhere in a
 * changed test file's path or its own changed lines, so a test that imports
 * `label-service` or names it in a describe block still counts. What counts
 * as a "test file" is `classifyChangedPath`'s `tests` bucket (js/ts `.test.`,
 * Go/Rust/C `_test.*`, Python, JVM, Ruby, Elixir conventions, and test
 * directories). Only source files are reported: generated, docs, and config
 * files, build files such as a `Makefile`, test doubles under a `mocks`
 * folder, and the tests themselves are never reported, because a test cannot
 * cover prose, settings, or another test's fake.
 */
export function untestedReach(
  files: ReadonlyArray<BriefReachFile>,
): ReadonlyArray<BriefReachUntested> {
  type ReachTestFile = { readonly stem: string; readonly dir: string };
  const testFiles: Array<ReachTestFile> = [];
  const candidates: Array<{
    readonly path: string;
    readonly stem: string;
    readonly dir: string;
  }> = [];
  const haystackParts: Array<string> = [];
  for (const file of files) {
    const bucket = classifyChangedPath({
      path: file.path,
      additions: 0,
      deletions: 0,
    });
    if (bucket === "tests") {
      testFiles.push({
        stem: normalizeReachIdentifier(pathStem(file.path)),
        dir: testDirForMatch(file.path),
      });
      haystackParts.push(
        normalizeReachIdentifier(file.path),
        normalizeReachIdentifier(file.changedText),
      );
      continue;
    }
    if (
      bucket === "core" &&
      isSourcePath(file.path) &&
      !isTestDoublePath(file.path)
    )
      candidates.push({
        path: file.path,
        stem: normalizeReachIdentifier(pathStem(file.path)),
        dir: dirname(normalizeReachPath(file.path)),
      });
  }
  const testDirs = new Set(testFiles.map((test) => test.dir));
  const haystack = haystackParts.join("\n");
  const untested: Array<BriefReachUntested> = [];
  for (const candidate of candidates) {
    if (
      candidate.stem !== "" &&
      testFiles.some((test) => isNameMatch(candidate.stem, test.stem))
    )
      continue;
    if (testDirs.has(candidate.dir)) continue;
    if (candidate.stem !== "" && haystack.includes(candidate.stem)) continue;
    untested.push({ path: candidate.path, reason: "no_test_in_pr" });
  }
  return untested;
}

/** True when a test file's folded stem names the production file's folded stem, with or without a trailing `test`/`spec`. */
function isNameMatch(productionStem: string, testStem: string): boolean {
  return (
    testStem === productionStem ||
    testStem === `${productionStem}test` ||
    testStem === `${productionStem}spec`
  );
}

/** Lower-cased with `-`, `_`, and `.` removed, so `update-plan` and `update_plan` compare equal. */
function normalizeReachIdentifier(text: string): string {
  return text.toLowerCase().replaceAll(/[-_.]/g, "");
}

/**
 * The directory a test file's "same directory" match compares against,
 * collapsing a `__tests__` sibling folder onto its parent so
 * `src/foo/__tests__/bar.test.ts` reads as the same directory as `src/foo`.
 */
function testDirForMatch(path: string): string {
  const dir = dirname(normalizeReachPath(path));
  const cut = dir.lastIndexOf("/");
  const lastSegment = cut === -1 ? dir : dir.slice(cut + 1);
  return lastSegment === "__tests__"
    ? cut === -1
      ? ""
      : dir.slice(0, cut)
    : dir;
}

/** A normalized path's directory, or `""` when the path carries no directory. */
function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** One changed file per `diff --git` section, with the lines the patch changed in it. */
export function briefReachFiles(patch: string): ReadonlyArray<BriefReachFile> {
  const files: Array<{ path: string; lines: Array<string> }> = [];
  let current: { path: string; lines: Array<string> } | undefined;
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      current = { path: token.newPath ?? token.oldPath ?? "", lines: [] };
      files.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (token.kind === "rename_to") current.path = token.path;
    if (token.kind === "body" && isChangedMarker(token.marker))
      current.lines.push(token.text);
  }
  const named: Array<BriefReachFile> = [];
  for (const file of files) {
    if (file.path === "" || file.path === "/dev/null") continue;
    named.push({ path: file.path, changedText: file.lines.join("\n") });
  }
  return named;
}

/** Assembles the block once the counted symbols are known; every other row is a path rule. */
export function summarizeReach(input: {
  readonly files: ReadonlyArray<BriefReachFile>;
  readonly symbols: ReadonlyArray<BriefReachSymbol>;
  readonly removedStillReferenced: ReadonlyArray<BriefReachRemoved>;
}): BriefReach {
  return {
    symbols: input.symbols,
    untested: untestedReach(input.files),
    removedStillReferenced: input.removedStillReferenced,
    method: "text_match",
    hop: 1,
  };
}

/** Which side of the patch a line rule reads. */
type ChangedSide = "added" | "removed" | "both";

function isReachIdentifier(name: string): boolean {
  return (
    name.length >= MIN_REACH_SYMBOL_LENGTH &&
    name.length <= MAX_REACH_SYMBOL_LENGTH &&
    REACH_IDENTIFIER_SYNTAX.test(name)
  );
}

/**
 * Whole-word containment. The needle has already passed
 * `REACH_IDENTIFIER_SYNTAX`, so it carries no regular-expression metacharacter
 * and can be spliced into a pattern directly.
 */
function appearsAsWholeWord(haystack: string, needle: string): boolean {
  if (!isReachIdentifier(needle)) return false;
  return new RegExp(`(?<![\\w$])${needle}(?![\\w$])`).test(haystack);
}

/** The added and/or removed line text of the whole patch, joined by newline. */
function changedLineText(patch: string, side: ChangedSide): string {
  const lines: Array<string> = [];
  for (const token of tokenizeUnifiedPatch(patch))
    if (token.kind === "body" && matchesSide(token.marker, side))
      lines.push(token.text);
  return lines.join("\n");
}

/** The names of `export`-shaped declarations on one side of the patch, deduped in patch order. */
function declaredNames(
  patch: string,
  side: ChangedSide,
): ReadonlyArray<string> {
  const names: Array<string> = [];
  const seen = new Set<string>();
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind !== "body" || !matchesSide(token.marker, side)) continue;
    const name = EXPORTED_DECLARATION_SYNTAX.exec(token.text)?.[1];
    if (name === undefined || seen.has(name) || !isReachIdentifier(name))
      continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function matchesSide(marker: string, side: ChangedSide): boolean {
  if (side === "both") return isChangedMarker(marker);
  return marker === side;
}

function isChangedMarker(marker: string): boolean {
  return marker === "added" || marker === "removed";
}

/** Windows-style separators reach Patchdesk only through hand-written input; the rules read `/`. */
function normalizeReachPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The file name without its extension: what a test file would mention it by. */
function pathStem(path: string): string {
  const name = basename(normalizeReachPath(path));
  const dot = name.indexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
