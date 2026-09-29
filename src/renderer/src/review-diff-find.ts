import type { FileDiffMetadata } from "@pierre/diffs";

import type {
  ReviewDiffNavigationStatus,
  ReviewNavDirection,
} from "./review-diff-keyboard-nav";

/**
 * One patch line that contains the ⌘F query. A line counts once however
 * often the query repeats in it, because a match marks its whole line.
 */
export type DiffFindMatch = {
  readonly path: string;
  /** Pierre's `data-line-type` for the row that draws this line. */
  readonly lineType: "change-addition" | "change-deletion" | "context";
  /** The line's number on `side`; a context line uses its new-file number. */
  readonly lineNumber: number;
  readonly side: "additions" | "deletions";
  /** A context line's old-file number, which its row in the deletions column shows. */
  readonly oldLineNumber?: number;
};

type FindableFile = Pick<
  FileDiffMetadata,
  "name" | "hunks" | "additionLines" | "deletionLines"
>;

/**
 * Every patch line in `files` that contains `query`, ignoring case, in file
 * order and then in the order a unified diff draws the lines: context, then a
 * change block's removed lines before its added lines. Hunk headers and
 * unchanged lines outside the hunks are never searched, so expanding Context
 * does not change the matches.
 */
export function findDiffMatches(
  files: ReadonlyArray<FindableFile>,
  query: string,
): DiffFindMatch[] {
  if (query === "") return [];
  const needle = query.toLocaleLowerCase();
  const contains = (line: string | undefined): boolean =>
    line !== undefined && line.toLocaleLowerCase().includes(needle);
  const matches: DiffFindMatch[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      let newLine = hunk.additionStart;
      let oldLine = hunk.deletionStart;
      for (const content of hunk.hunkContent) {
        if (content.type === "context") {
          for (let offset = 0; offset < content.lines; offset += 1) {
            if (
              contains(file.additionLines[content.additionLineIndex + offset])
            )
              matches.push({
                path: file.name,
                lineType: "context",
                lineNumber: newLine,
                side: "additions",
                oldLineNumber: oldLine,
              });
            newLine += 1;
            oldLine += 1;
          }
          continue;
        }
        for (let offset = 0; offset < content.deletions; offset += 1) {
          if (contains(file.deletionLines[content.deletionLineIndex + offset]))
            matches.push({
              path: file.name,
              lineType: "change-deletion",
              lineNumber: oldLine,
              side: "deletions",
            });
          oldLine += 1;
        }
        for (let offset = 0; offset < content.additions; offset += 1) {
          if (contains(file.additionLines[content.additionLineIndex + offset]))
            matches.push({
              path: file.name,
              lineType: "change-addition",
              lineNumber: newLine,
              side: "additions",
            });
          newLine += 1;
        }
      }
    }
  }
  return matches;
}

/**
 * The match one Enter or Shift+Enter lands on from `current`, wrapping past
 * either end. `current` undefined means no match has been visited yet, so
 * Enter lands on the first match and Shift+Enter on the last.
 */
export function adjacentFindMatch(
  total: number,
  current: number | undefined,
  direction: ReviewNavDirection,
): { readonly index: number; readonly wrapped: boolean } | undefined {
  if (total === 0) return undefined;
  if (current === undefined)
    return { index: direction === "next" ? 0 : total - 1, wrapped: false };
  const step = direction === "next" ? current + 1 : current - 1;
  if (step >= total) return { index: 0, wrapped: true };
  if (step < 0) return { index: total - 1, wrapped: true };
  return { index: step, wrapped: false };
}

/** Builds the structured outcome for one landed find step. */
export function findNavigationStatus(
  match: DiffFindMatch,
  index: number,
  total: number,
  wrapped: boolean,
  direction: ReviewNavDirection,
): ReviewDiffNavigationStatus {
  const landed = `Match ${index + 1} of ${total}: ${match.path} line ${match.lineNumber}.`;
  return {
    kind: "find",
    state: wrapped ? "wrapped" : "target",
    position: index + 1,
    total,
    path: match.path,
    line: match.lineNumber,
    message: wrapped
      ? `Wrapped to the ${direction === "next" ? "first" : "last"} match. ${landed}`
      : landed,
  };
}

/**
 * The stylesheet that marks `match`'s row inside its file's shadow root.
 * Pierre's own rules sit in `@layer base`, so this unlayered rule wins. The
 * row's `data-line` is the number on its column's side, which is why a
 * context line names its old number in the deletions column.
 */
export function diffFindMatchRowCss(match: DiffFindMatch): string {
  const row = (column: string, line: number, altLine?: number): string =>
    `${column} [data-line-type="${match.lineType}"][data-line="${line}"]${altLine === undefined ? "" : `[data-alt-line="${altLine}"]`}`;
  const selectors =
    match.lineType === "context" && match.oldLineNumber !== undefined
      ? [
          row(
            ":is([data-unified], [data-additions])",
            match.lineNumber,
            match.oldLineNumber,
          ),
          row("[data-deletions]", match.oldLineNumber, match.lineNumber),
        ]
      : [
          row(
            match.side === "additions"
              ? ":is([data-unified], [data-additions])"
              : ":is([data-unified], [data-deletions])",
            match.lineNumber,
          ),
        ];
  // An inset shadow paints over the row's own background, so the tint keeps its added or removed colour.
  return `${selectors.join(", ")} { box-shadow: inset 3px 0 0 var(--diff-find-match), inset 0 0 0 100vmax color-mix(in srgb, var(--diff-find-match) 28%, transparent); }`;
}
