import { tokenizeUnifiedPatch } from "./unified-patch";

/*
 * The exported top-level declarations a patch changes the inside of. A method
 * body edit leaves `export class ReviewRefreshService {` untouched, so the
 * declaration-line rule in `brief-reach.ts` never sees it; this module maps
 * each changed line to the top-level declaration around it at the head.
 */

/**
 * What counts as exported, per language: a TS/JS `export`, a capitalized Go
 * `func`/`type`/`var`/`const`, and a Python top-level `def`/`class` not
 * starting with `_`. Any other extension uses the TS/JS rule.
 */
const EXPORT_HEADS: ReadonlyArray<{
  readonly extensions: ReadonlyArray<string>;
  readonly pattern: RegExp;
}> = [
  {
    extensions: [".go"],
    pattern: /^(?:func\s+(?:\([^)]*\)\s*)?|(?:type|var|const)\s+)([A-Z]\w*)/,
  },
  {
    extensions: [".py"],
    pattern: /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/,
  },
];
const TS_EXPORT_HEAD =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s*|(?:class|interface|type|enum|const|let|var|namespace)\s+)([A-Za-z_$][\w$]*)/;

/**
 * Names of the exported top-level declarations enclosing the patch's changed
 * lines, in patch order. `headLines` holds each changed file's text at the
 * represented head, keyed by its new-side path; a file missing from it adds
 * nothing.
 */
export function changedEnclosingExports(
  patch: string,
  headLines: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> {
  const names: Array<string> = [];
  const seen = new Set<string>();
  for (const file of changedSites(patch)) {
    const lines = headLines.get(file.path);
    if (lines === undefined) continue;
    const head = exportHead(file.path);
    for (const site of file.sites) {
      const [first, ...rest] = site.map((line) =>
        enclosingExport(lines, line - 1, head),
      );
      if (first === undefined || rest.some((name) => name !== first)) continue;
      if (seen.has(first)) continue;
      seen.add(first);
      names.push(first);
    }
  }
  return names;
}

/**
 * Each changed file's new-side line numbers the patch touched. An added line
 * is one site; a removed line is the pair of new-side lines around it, and
 * counts only when both sit in the same declaration, so deleting a whole
 * function between two others names neither neighbour.
 */
function changedSites(
  patch: string,
): ReadonlyArray<{ path: string; sites: Array<ReadonlyArray<number>> }> {
  const files: Array<{ path: string; sites: Array<ReadonlyArray<number>> }> =
    [];
  let current: (typeof files)[number] | undefined;
  let lastNewLine = 0;
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      current = { path: token.newPath ?? token.oldPath ?? "", sites: [] };
      files.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (token.kind === "rename_to") current.path = token.path;
    if (token.kind === "hunk_header") lastNewLine = token.range.newStart - 1;
    if (token.kind !== "body") continue;
    if (token.marker === "removed")
      current.sites.push([lastNewLine, lastNewLine + 1]);
    if (token.newLine === undefined) continue;
    if (token.marker === "added") current.sites.push([token.newLine]);
    lastNewLine = token.newLine;
  }
  return files;
}

function exportHead(path: string): RegExp {
  return (
    EXPORT_HEADS.find((rule) =>
      rule.extensions.some((extension) => path.endsWith(extension)),
    )?.pattern ?? TS_EXPORT_HEAD
  );
}

/**
 * The exported declaration owning `lineIndex` (0-based): the nearest line
 * above it at column zero that is not blank, a comment, or a closing bracket.
 * A top-level line that is not an exported head, such as a local helper,
 * owns the line and yields nothing.
 */
function enclosingExport(
  lines: ReadonlyArray<string>,
  lineIndex: number,
  head: RegExp,
): string | undefined {
  const own = lines[lineIndex]?.trim();
  if (own === undefined || own === "" || isComment(own)) return undefined;
  for (let index = lineIndex; index >= 0; index -= 1) {
    const text = lines[index] ?? "";
    const trimmed = text.trim();
    if (text !== text.trimStart() || trimmed === "" || isComment(trimmed))
      continue;
    if (/^[}\])]/.test(trimmed)) continue;
    return head.exec(text)?.[1];
  }
  return undefined;
}

function isComment(trimmed: string): boolean {
  return /^(?:\/\/|\/\*|\*|#)/.test(trimmed);
}
