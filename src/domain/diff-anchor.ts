import type { RepoRelativePath } from "./ids";
import type { PendingReviewAnchor } from "./pending-review";
import { tokenizeUnifiedPatch } from "./unified-patch";

/** Exact current-diff context that validates one explicit inline command. */
export type ReviewAnchorFingerprint = {
  readonly path: RepoRelativePath;
  readonly side: "new" | "old";
  readonly startLine: number;
  readonly line: number;
  readonly selectedLines: ReadonlyArray<string>;
  readonly before: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
};

type PatchLine = {
  readonly path: string;
  readonly side: "new" | "old";
  readonly line: number;
  readonly text: string;
  readonly hunk: number;
};

const contextLines = 2;

/** Captures the exact represented diff context for one current inline command. */
export function fingerprintPatchAnchor(
  patch: string,
  anchor: PendingReviewAnchor,
): ReviewAnchorFingerprint | undefined {
  const lines = sideLines(patchLines(patch), anchor);
  const start = lines.findIndex((line) => line.line === anchor.startLine);
  const end = lines.findIndex((line) => line.line === anchor.line);
  if (start < 0 || end < start || lines[start]?.hunk !== lines[end]?.hunk)
    return undefined;
  if (end - start + 1 !== anchor.line - anchor.startLine + 1) return undefined;
  return {
    path: anchor.path,
    side: anchor.side,
    startLine: anchor.startLine,
    line: anchor.line,
    ...contextAt(lines, start, end),
  };
}

/**
 * Every place in `patch` whose selected lines and surrounding diff context
 * equal the fingerprint's, by the same rules that captured it. One result is
 * an unambiguous location; none or several are not.
 */
export function locatePatchAnchor(
  patch: string,
  fingerprint: ReviewAnchorFingerprint,
): ReadonlyArray<{ readonly startLine: number; readonly line: number }> {
  const lines = sideLines(patchLines(patch), fingerprint);
  const length = fingerprint.selectedLines.length;
  const found: Array<{ readonly startLine: number; readonly line: number }> =
    [];
  for (let start = 0; start + length <= lines.length; start += 1) {
    const end = start + length - 1;
    const first = lines[start];
    const last = lines[end];
    if (first === undefined || last === undefined || first.hunk !== last.hunk)
      continue;
    const context = contextAt(lines, start, end);
    if (
      sameTexts(context.selectedLines, fingerprint.selectedLines) &&
      sameTexts(context.before, fingerprint.before) &&
      sameTexts(context.after, fingerprint.after)
    )
      found.push({ startLine: first.line, line: last.line });
  }
  return found;
}

function sideLines(
  lines: ReadonlyArray<PatchLine>,
  anchor: { readonly path: string; readonly side: "new" | "old" },
): ReadonlyArray<PatchLine> {
  return lines.filter(
    (line) => line.path === anchor.path && line.side === anchor.side,
  );
}

/** The selected lines `start..end` and up to two lines either side of them in the same hunk. */
function contextAt(
  lines: ReadonlyArray<PatchLine>,
  start: number,
  end: number,
): Pick<ReviewAnchorFingerprint, "selectedLines" | "before" | "after"> {
  const hunk = lines[start]?.hunk;
  const inHunk = (line: PatchLine) => (line.hunk === hunk ? [line.text] : []);
  return {
    selectedLines: lines.slice(start, end + 1).map((line) => line.text),
    before: lines
      .slice(Math.max(0, start - contextLines), start)
      .flatMap(inHunk),
    after: lines.slice(end + 1, end + contextLines + 1).flatMap(inHunk),
  };
}

function sameTexts(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((text, index) => text === right[index])
  );
}

function patchLines(patch: string): ReadonlyArray<PatchLine> {
  const lines: PatchLine[] = [];
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let hunk = 0;
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      oldPath = token.oldPath;
      newPath = token.newPath;
      continue;
    }
    if (token.kind === "old_file_path") {
      oldPath = token.path;
      continue;
    }
    if (token.kind === "new_file_path") {
      newPath = token.path;
      continue;
    }
    if (token.kind === "hunk_header") {
      hunk += 1;
      continue;
    }
    if (token.kind !== "body" || token.marker === "no_newline") continue;
    if (oldPath === undefined || newPath === undefined) continue;
    if (token.oldLine !== undefined && oldPath !== "/dev/null")
      lines.push({
        path: oldPath,
        side: "old",
        line: token.oldLine,
        text: token.text,
        hunk,
      });
    if (token.newLine !== undefined && newPath !== "/dev/null")
      lines.push({
        path: newPath,
        side: "new",
        line: token.newLine,
        text: token.text,
        hunk,
      });
  }
  return lines;
}
