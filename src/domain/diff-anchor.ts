import type { RepoRelativePath } from "./ids";
import type { PendingReviewAnchor } from "./pending-review";

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
      .filter((line) => line.hunk === hunk)
      .map((line) => line.text),
    after: lines
      .slice(end + 1, end + contextLines + 1)
      .filter((line) => line.hunk === hunk)
      .map((line) => line.text),
  };
}

function patchLines(patch: string): ReadonlyArray<PatchLine> {
  const lines: PatchLine[] = [];
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let hunk = 0;
  for (const raw of patch.split("\n")) {
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (fileHeader !== null) {
      oldPath = fileHeader[1];
      newPath = fileHeader[2];
      continue;
    }
    if (raw.startsWith("--- ")) {
      oldPath = patchPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      newPath = patchPath(raw.slice(4));
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk += 1;
      continue;
    }
    if (
      hunk === 0 ||
      raw.startsWith("\\") ||
      oldPath === undefined ||
      newPath === undefined
    )
      continue;
    if (raw.startsWith("-")) {
      if (oldPath !== "/dev/null")
        lines.push({
          path: oldPath,
          side: "old",
          line: oldLine,
          text: raw.slice(1),
          hunk,
        });
      oldLine += 1;
    } else if (raw.startsWith("+")) {
      if (newPath !== "/dev/null")
        lines.push({
          path: newPath,
          side: "new",
          line: newLine,
          text: raw.slice(1),
          hunk,
        });
      newLine += 1;
    } else if (raw.startsWith(" ")) {
      if (oldPath !== "/dev/null")
        lines.push({
          path: oldPath,
          side: "old",
          line: oldLine,
          text: raw.slice(1),
          hunk,
        });
      if (newPath !== "/dev/null")
        lines.push({
          path: newPath,
          side: "new",
          line: newLine,
          text: raw.slice(1),
          hunk,
        });
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
}

function patchPath(value: string): string {
  const path = value.split("\t", 1)[0] ?? value;
  return path === "/dev/null" ? path : path.replace(/^[ab]\//, "");
}
