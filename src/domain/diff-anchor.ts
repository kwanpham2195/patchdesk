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
  const lines = patchLines(patch).filter(
    (line) => line.path === anchor.path && line.side === anchor.side,
  );
  const start = lines.findIndex((line) => line.line === anchor.startLine);
  const end = lines.findIndex((line) => line.line === anchor.line);
  if (start < 0 || end < start || lines[start]?.hunk !== lines[end]?.hunk)
    return undefined;
  const selected = lines.slice(start, end + 1);
  if (selected.length !== anchor.line - anchor.startLine + 1) return undefined;
  const hunk = selected[0]?.hunk;
  if (hunk === undefined) return undefined;
  return {
    path: anchor.path,
    side: anchor.side,
    startLine: anchor.startLine,
    line: anchor.line,
    selectedLines: selected.map((line) => line.text),
    before: lines
      .slice(Math.max(0, start - contextLines), start)
      .flatMap((line) => (line.hunk === hunk ? [line.text] : [])),
    after: lines
      .slice(end + 1, end + contextLines + 1)
      .flatMap((line) => (line.hunk === hunk ? [line.text] : [])),
  };
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
