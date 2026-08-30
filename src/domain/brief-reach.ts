import { classifyChangedPath } from "./change-scope";
import { tokenizeUnifiedPatch } from "./unified-patch";

/*
 * The Brief reader draws this block under the heading "Reach": what depends on
 * the changed code, one hop out, by text match.
 *
 * Nothing here asks a model for a number. A model may propose symbol names; a
 * name survives only when it is a plausible identifier that actually appears on
 * an added or removed line of the patch, and the counting itself is a
 * `git grep` run by `src/services/brief-reach-service.ts`. Every rule below is
 * a text rule, so the block is labelled "text match" and never "call graph".
 */

/** A name a model may propose, or a declaration the patch itself carries. */
const REACH_IDENTIFIER_SYNTAX = /^[A-Za-z_$][\w$]*$/;
const MIN_REACH_SYMBOL_LENGTH = 2;
const MAX_REACH_SYMBOL_LENGTH = 80;
/**
 * Past a dozen symbols the block stops being a reading order and becomes a
 * list. This is the cap on names Patchdesk *counts*; `briefOutputSchema`'s own
 * `MAX_REACH_SYMBOLS` is the wider cap on names a child may propose.
 */
const MAX_COUNTED_REACH_SYMBOLS = 12;
/** How many outside paths one symbol names before the rest become a count. */
export const MAX_REACH_OUTSIDE_PATHS = 5;

/**
 * An `export`-shaped declaration head, used both for the fallback when a model
 * proposes nothing and for the removed-symbol rule. Go's `func Name(` is
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
};

/** One surface the changed paths either cross or do not; an unlit surface is still reported. */
export type BriefReachSurface = {
  readonly surface: string;
  /** The first changed path that lit this surface; absent when unlit. */
  readonly path?: string;
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
};

/**
 * The Reach block. `method` and `hop` are stored beside the counts so the
 * reader's footer states how the numbers were made without inferring it.
 */
export type BriefReach = {
  readonly symbols: ReadonlyArray<BriefReachSymbol>;
  readonly surfaces: ReadonlyArray<BriefReachSurface>;
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

/** The default surface rules, in the order the reader draws their chips. */
const REACH_SURFACE_RULES: ReadonlyArray<{
  readonly surface: string;
  readonly matches: (path: string) => boolean;
}> = [
  {
    surface: "Public API",
    matches: (path) =>
      /^src\/index\.[^/]+$/.test(path) ||
      path.endsWith(".d.ts") ||
      hasSegment(path, "api") ||
      basename(path).startsWith("openapi"),
  },
  {
    surface: "CLI",
    matches: (path) =>
      hasSegment(path, "bin") ||
      hasSegment(path, "cli") ||
      hasSegment(path, "cmd"),
  },
  {
    surface: "Stored data",
    matches: (path) =>
      hasSegment(path, "migrations") ||
      hasSegment(path, "prisma") ||
      path.endsWith(".sql") ||
      basename(path).startsWith("schema") ||
      basename(path).includes("store"),
  },
  {
    surface: "Security boundary",
    matches: (path) =>
      path.startsWith(".github/workflows/") ||
      ["auth", "permission", "sandbox", "credential", "capability"].some(
        (word) => path.includes(word),
      ),
  },
  {
    surface: "Network write path",
    matches: (path) =>
      hasSegment(path, "adapters") ||
      basename(path).includes("client") ||
      basename(path).includes("writer"),
  },
];

/**
 * The symbol names Patchdesk will count callers for.
 *
 * A proposed name survives only when it looks like an identifier and appears as
 * a whole word on a line the patch added or removed -- a model naming something
 * the diff never touched is naming something it did not read. When the model
 * proposes nothing usable, the patch's own `export`-shaped declarations stand
 * in, so the block still has something to count.
 */
export function candidateReachSymbols(
  patch: string,
  proposed: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const changed = changedLineText(patch, "both");
  const kept: Array<string> = [];
  const seen = new Set<string>();
  for (const name of proposed) {
    const trimmed = name.trim();
    if (!isReachIdentifier(trimmed) || seen.has(trimmed)) continue;
    if (!appearsAsWholeWord(changed, trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
    if (kept.length === MAX_COUNTED_REACH_SYMBOLS) return kept;
  }
  if (kept.length > 0) return kept;
  return declaredNames(patch, "both").slice(0, MAX_COUNTED_REACH_SYMBOLS);
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
 * Which surfaces the changed paths cross, each citing the first path that lit
 * it. A surface no path matched is reported unlit rather than omitted: "this
 * change touches no security boundary" is the half of the answer a reviewer
 * cannot get from a list of what it does touch.
 */
export function surfacesCrossed(
  changedPaths: ReadonlyArray<string>,
): ReadonlyArray<BriefReachSurface> {
  const paths = changedPaths.map((path) => normalizeReachPath(path));
  return REACH_SURFACE_RULES.map((rule) => {
    const path = paths.find((candidate) => rule.matches(candidate));
    return path === undefined
      ? { surface: rule.surface }
      : { surface: rule.surface, path };
  });
}

/**
 * Changed files no changed test mentions. "Mentions" is a substring test over
 * every changed test file's path and its own changed lines, so a test that
 * imports `label-service` or names it in a describe block counts as covering
 * it. Generated files and the tests themselves are never reported.
 */
export function untestedReach(
  files: ReadonlyArray<BriefReachFile>,
): ReadonlyArray<BriefReachUntested> {
  const testText: Array<string> = [];
  const candidates: Array<string> = [];
  for (const file of files) {
    const bucket = classifyChangedPath({
      path: file.path,
      additions: 0,
      deletions: 0,
    });
    if (bucket === "tests") {
      testText.push(file.path, file.changedText);
      continue;
    }
    if (bucket !== "generated") candidates.push(file.path);
  }
  const haystack = testText.join("\n");
  const untested: Array<BriefReachUntested> = [];
  for (const path of candidates) {
    const stem = pathStem(path);
    if (stem !== "" && haystack.includes(stem)) continue;
    untested.push({ path, reason: "no_test_in_pr" });
  }
  return untested;
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
    surfaces: surfacesCrossed(input.files.map((file) => file.path)),
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

/** True when one of the path's directory segments, or its file name, is `segment`. */
function hasSegment(path: string, segment: string): boolean {
  return path.split("/").includes(segment);
}

/** The file name without its extension: what a test file would mention it by. */
function pathStem(path: string): string {
  const name = basename(normalizeReachPath(path));
  const dot = name.indexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
