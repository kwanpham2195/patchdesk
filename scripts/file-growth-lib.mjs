/**
 * How the size ratchet measures a file, and the one kind of growth it
 * forgives.
 *
 * The ratchet itself lives in `checkFileSizes`
 * (`scripts/lint-staged-lib.mjs`). This module holds the two decisions that
 * are worth reading and testing on their own: how many lines a blob has, and
 * whether a growth is nothing but added import specifiers.
 */

/**
 * Lines in `content`. A trailing newline terminates the last line rather than
 * starting an empty one, so `"a\n"` is one line and so is `"a"`.
 *
 * @param {string} content
 * @returns {number}
 */
export function countLines(content) {
  if (content === "") return 0;
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/**
 * Whether the whole difference between `baseContent` and `headContent` is
 * import specifiers that were added.
 *
 * The problem this exists for, from milestone E3: `src/main/local-api.ts` was
 * 3,033 lines, over the ratchet's ceiling and therefore frozen. Replacing two
 * inline type annotations with a named type meant importing that name -- a
 * third specifier on an existing import line, which Oxfmt then wraps onto its
 * own line. 3,033 -> 3,034, and the ratchet refused a one-line change whose
 * whole purpose was to remove duplication. The ratchet was pushing the file
 * away from being smaller.
 *
 * So this forgives that, and only that. Two conditions have to hold together:
 *
 * 1. **Nothing outside the import declarations grew.** The two files are
 *    compared line by line, by text. A line `head` has that `base` does not
 *    is an *added* line; a line `base` has that `head` does not is a
 *    *removed* line. Added lines that are not import lines may not outnumber
 *    removed lines that are not import lines. Body, blanks, comments, a
 *    directive prologue, a comment sitting inside an import's own braces --
 *    all of it may be rewritten or deleted, and none of it may gain a line.
 * 2. **At least one import specifier was added.** Reformatting alone buys
 *    nothing; the growth has to be carrying a new import.
 *
 * Comparing the *text* of the lines that differ, rather than a count of the
 * lines in each bucket, is the load-bearing choice. An earlier version
 * compared `head.otherLines <= base.otherLines`, two net counts derived from
 * where the import region happened to end. Net counts can be inflated:
 * anything that made the head region cover more lines bought exactly that
 * many lines of arbitrary body content elsewhere, because both numbers moved
 * together and their difference did not. A trailing `// why` on an import
 * declaration did it without bound, and a `"use client";` prologue or a block
 * comment opened on the first import's own line did it up to the file's
 * import count. Here a line
 * that was not in the file before has to be an import line *at head* to be
 * free, so moving the region boundary buys nothing: it relabels lines both
 * files already share, and shared lines are neither added nor removed.
 *
 * What is left is buying lines of import syntax that `readImportRegion` has
 * actually parsed as part of a declaration. Two checks the same gate already
 * runs over the same files close that off: Oxlint's `no-unused-vars`
 * (`error`, repo-wide) rejects a specifier nothing uses, and Oxfmt `--check`
 * decides what shape an import declaration has, so an author cannot spread
 * one over lines of their own choosing. A forgiven line ends up being what an
 * import the code actually calls needs.
 *
 * The exemption applies to the growth rule only. A new file over the new-file
 * limit has no base to compare against, so it is never forgiven.
 *
 * @param {string} baseContent
 * @param {string} headContent
 * @returns {boolean}
 */
export function isImportSpecifierOnlyGrowth(baseContent, headContent) {
  if (countLines(headContent) <= countLines(baseContent)) return false;

  const base = readImportRegion(baseContent);
  const head = readImportRegion(headContent);

  const added = surplusOutsideImports(head, base, true);
  const removed = surplusOutsideImports(base, head, false);
  if (added > removed) return false;

  return head.specifiers > base.specifiers;
}

/**
 * How many lines `left` has that `right` does not have, counting only the
 * ones `left` does not read as import lines.
 *
 * A line is "had" by `right` as many times as `right` repeats it, so adding
 * a second copy of a line that already appears once still counts as added.
 *
 * When the same text appears both as an import line and as an ordinary line,
 * which copy is left over is a choice, and each caller makes the strict one.
 * Reading the added lines matches `left`'s import lines first, so what is
 * left over lands on ordinary lines; reading the removed lines matches
 * `left`'s ordinary lines first, so it does not.
 *
 * @param {ReturnType<typeof readImportRegion>} left
 * @param {ReturnType<typeof readImportRegion>} right
 * @param {boolean} matchImportLinesFirst
 * @returns {number}
 */
function surplusOutsideImports(left, right, matchImportLinesFirst) {
  const available = new Map();
  for (const line of right.lines) {
    available.set(line, (available.get(line) ?? 0) + 1);
  }

  const matched = new Set();
  const matchPass = (wantImportLine) => {
    for (const [index, line] of left.lines.entries()) {
      if (left.isImportLine[index] !== wantImportLine) continue;
      const copies = available.get(line) ?? 0;
      if (copies === 0) continue;
      available.set(line, copies - 1);
      matched.add(index);
    }
  };
  matchPass(matchImportLinesFirst);
  matchPass(!matchImportLinesFirst);

  let surplus = 0;
  for (let index = 0; index < left.lines.length; index += 1) {
    if (!matched.has(index) && left.isImportLine[index] !== true) surplus += 1;
  }
  return surplus;
}

/**
 * Reads the file's leading import region and marks which of its lines are
 * import lines: the run of import declarations at the top, with blank lines,
 * comments, a shebang, and a directive prologue (`"use client";`) allowed
 * between them.
 *
 * Membership is decided by import syntax, not by punctuation. A declaration
 * is read a line at a time and ends where the text *parses* as a whole import
 * declaration -- a recognised clause, then `from`, then a module specifier.
 * Nothing else ends it: a run of lines that never parses ends the region
 * instead of being absorbed into it, and so does a clause that is not import
 * syntax. So no line is marked an import line unless it carries part of a
 * declaration this function has read whole.
 *
 * Scanning stops at the first line that starts anything else, so an `import`
 * further down the file -- inside a template literal holding a code fixture,
 * for instance -- is never mistaken for a declaration. A dynamic
 * `import(...)` is excluded by requiring whitespace after the keyword.
 *
 * @param {string} content
 * @returns {{
 *   readonly lines: ReadonlyArray<string>;
 *   readonly isImportLine: ReadonlyArray<boolean>;
 *   readonly specifiers: number;
 * }}
 */
function readImportRegion(content) {
  const lines = splitLines(content);
  const code = stripComments(lines);
  const isImportLine = lines.map(() => false);

  let index = 0;
  let specifiers = 0;
  let sawImport = false;

  while (index < lines.length) {
    const text = code[index] ?? "";

    if (text === "" || text.startsWith("#!")) {
      index += 1;
      continue;
    }
    if (!sawImport && DIRECTIVE_PROLOGUE.test(text)) {
      index += 1;
      continue;
    }
    if (!isImportDeclarationStart(text)) break;

    const declaration = readDeclaration(code, index);
    if (declaration === undefined) break;

    sawImport = true;
    specifiers += declaration.specifiers;
    for (let line = index; line <= declaration.end; line += 1) {
      isImportLine[line] = (code[line] ?? "") !== "";
    }
    index = declaration.end + 1;
  }

  return { lines, isImportLine, specifiers };
}

/**
 * The lines of `content`, with a trailing newline read as a terminator rather
 * than as an empty last line -- the same convention as `countLines`.
 */
function splitLines(content) {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Each line's code, with its comments removed and its ends trimmed. Block
 * comments carry across lines, and string literals are respected so that the
 * `//` in a module specifier such as `"https://example.test/m"` is not read
 * as the start of a comment.
 *
 * A line whose code is empty is blank, a comment, or the inside of one, and
 * is never an import line: a comment must not be a free place to add lines.
 * A line that is import syntax *and* a comment -- `} from "./m"; // why` --
 * has code, and is an import line, because the alternative is that deleting
 * the comment later turns an ordinary line into an import line and buys one.
 */
function stripComments(lines) {
  const code = [];
  let inBlockComment = false;

  for (const line of lines) {
    let kept = "";
    let index = 0;

    while (index < line.length) {
      const pair = line.slice(index, index + 2);
      if (inBlockComment) {
        if (pair === "*/") inBlockComment = false;
        index += pair === "*/" ? 2 : 1;
        continue;
      }
      if (pair === "/*") {
        inBlockComment = true;
        index += 2;
        continue;
      }
      if (pair === "//") break;

      const character = line[index] ?? "";
      if (character === '"' || character === "'" || character === "`") {
        const end = findStringEnd(line, index, character);
        kept += line.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      kept += character;
      index += 1;
    }

    code.push(kept.trim());
  }

  return code;
}

/**
 * The index of the quote that closes the literal opened at `start`, or the
 * last index of the line when it does not close there. A literal left open
 * takes the rest of the line, which is what a line of prose holding an
 * apostrophe wants: either way the line is not an import declaration and the
 * region ends at it.
 */
function findStringEnd(line, start, quote) {
  for (let index = start + 1; index < line.length; index += 1) {
    if (line[index] === "\\") {
      index += 1;
      continue;
    }
    if (line[index] === quote) return index;
  }
  return line.length - 1;
}

/**
 * A declaration is at most this many lines. Oxfmt puts one specifier on a
 * line, so this is already a very large import; a longer run of lines is not
 * a declaration anyone wrote, and reading it as one is what this bound
 * refuses.
 */
const MAX_DECLARATION_LINES = 200;

/**
 * Reads one import declaration starting at `start`, taking a line at a time
 * until the text parses as a whole declaration.
 *
 * The stopping rule is the point of this function. It does not look for
 * punctuation the author controls -- the version this replaced ended a
 * declaration at the first line whose trimmed text ended in `;`, which a
 * trailing comment defeats. It asks instead whether what it has read is an
 * import declaration yet, and gives up once the text can no longer become
 * one: a statement terminator or a module specifier has gone by without the
 * whole thing parsing.
 *
 * @returns {{ readonly end: number; readonly specifiers: number } | undefined}
 *   `undefined` when the lines at `start` are not a complete declaration, in
 *   which case the caller ends the import region there.
 */
function readDeclaration(code, start) {
  let text = "";
  const last = Math.min(code.length, start + MAX_DECLARATION_LINES);

  for (let index = start; index < last; index += 1) {
    text = text === "" ? (code[index] ?? "") : `${text} ${code[index] ?? ""}`;

    const specifiers = countSpecifiers(text);
    if (specifiers !== undefined) return { end: index, specifiers };
    if (!isDeclarationPrefix(text)) return undefined;
  }

  return undefined;
}

/**
 * Whether `text` could still become an import declaration by taking another
 * line. Once a statement terminator or a module specifier has gone by
 * without the text parsing, it cannot.
 */
function isDeclarationPrefix(text) {
  if (text.includes(";")) return false;
  return !/\bfrom\s+["']/.test(text);
}

/**
 * An import *declaration*, not an expression. `import(` and `import.meta` are
 * both excluded by requiring whitespace after the keyword; `import (` -- a
 * dynamic import with a space -- is excluded by rejecting a `(` after it.
 */
function isImportDeclarationStart(trimmed) {
  return /^import\s+(?![(])/.test(trimmed);
}

/**
 * A directive prologue -- `"use client";`, `"use strict";` -- ahead of the
 * first import. Left to end the region it would make every import below it an
 * ordinary line, so deleting the directive later would turn them all into
 * import lines at once. Three files under `src/renderer/src/components/ui/`
 * open with `"use client";` today.
 */
const DIRECTIVE_PROLOGUE = /^(["'])(?:(?!\1)[^\\])*\1\s*;?$/;

const IDENTIFIER = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;
/** One name inside `{ ... }`: `beta`, `beta as b`, `type Beta`. */
const NAMED_BINDING = new RegExp(
  String.raw`^(?:type\s+)?${IDENTIFIER}(?:\s+as\s+${IDENTIFIER})?$`,
);
const NAMESPACE_BINDING = new RegExp(String.raw`^\*\s+as\s+${IDENTIFIER}$`);
const DEFAULT_BINDING = new RegExp(String.raw`^(?:${IDENTIFIER})\s*(?:,\s*|$)`);

/**
 * Specifiers bound by one whole import declaration: `import a, { b, c as d }
 * from "m";` binds three. A side-effect import (`import "m";`) binds none.
 *
 * @returns {number | undefined} `undefined` when `declaration` is not a
 *   complete import declaration, or when its clause is not something this
 *   recognises as import syntax. Either way the caller reads it as "not a
 *   declaration", so an unrecognised clause can never pay for a line.
 */
function countSpecifiers(declaration) {
  if (/^import\s+(["'])(?:(?!\1).)*\1\s*;?$/.test(declaration)) return 0;

  const match = /^import\s+([\s\S]*?)\s+from\s+(["'])(?:(?!\2).)*\2\s*;?$/.exec(
    declaration,
  );
  if (match === null) return undefined;
  return countClauseBindings((match[1] ?? "").trim());
}

/**
 * The names an import clause binds, or `undefined` when the clause is not one
 * of the shapes the language allows: a default binding, a namespace binding,
 * a braced list, or a default binding followed by either.
 */
function countClauseBindings(clause) {
  let rest = clause.replace(/^type\s+/, "");
  let count = 0;

  const first = DEFAULT_BINDING.exec(rest);
  if (first !== null) {
    count += 1;
    rest = rest.slice(first[0].length).trim();
    if (rest === "") return count;
  }

  if (NAMESPACE_BINDING.test(rest)) return count + 1;
  if (!rest.startsWith("{") || !rest.endsWith("}")) return undefined;

  const inner = rest.slice(1, -1).trim();
  if (inner === "") return count;
  for (const part of inner.split(",")) {
    const binding = part.trim();
    if (binding === "") continue; // a trailing comma
    if (!NAMED_BINDING.test(binding)) return undefined;
    count += 1;
  }
  return count;
}
