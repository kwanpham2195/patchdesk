import { parseRepoRelativePath, type RepoRelativePath } from "./ids";
import { err, ok, type Result } from "./result";
import {
  tokenizeUnifiedPatchLines,
  type UnifiedHunkRange,
  type UnifiedPatchToken,
} from "./unified-patch";

/** Exact captured hunk text and coordinates, in the canonical alias order. */
type NarrativePatchHunk = {
  readonly id: string;
  readonly path: RepoRelativePath;
  readonly header: string;
  readonly raw: string;
  readonly filePrefix: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

/** File headers and hunks from one complete, verified unified patch. */
export type NarrativePatch = {
  readonly files: ReadonlyArray<{
    /** Includes header-only and binary blocks, matching the complete inventory's order. */
    readonly ordinal: number;
    readonly prefix: string;
    readonly hunks: ReadonlyArray<NarrativePatchHunk>;
  }>;
  readonly hunks: ReadonlyArray<NarrativePatchHunk>;
};

type InvalidNarrativePatch = {
  readonly _tag: "InvalidNarrativeWalkthrough";
  readonly reason: "invalid_patch";
};

const MAX_PATCH_LINE_COORDINATE = 1_000_000;
const MAX_HUNK_LINE_COUNT = 100_000;
const MAX_HUNK_RAW_LENGTH = 200_000;
const MAX_NARRATIVE_FILE_PREFIX_LENGTH = 8_192;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function invalid(): Result<never, InvalidNarrativePatch> {
  return err({ _tag: "InvalidNarrativeWalkthrough", reason: "invalid_patch" });
}

function parseDiffPath(value: string) {
  const path = parseRepoRelativePath(
    value === "/dev/null" ? "dev/null" : value,
  );
  return path._tag === "err" ? invalid() : ok(path.value);
}

function validHunkRange(range: UnifiedHunkRange): boolean {
  const coordinates = [
    range.oldStart,
    range.oldLines,
    range.newStart,
    range.newLines,
  ];
  if (!coordinates.every(Number.isSafeInteger)) return false;
  return (
    validRange(range.oldStart, range.oldLines) &&
    validRange(range.newStart, range.newLines)
  );
}

function validRange(start: number, lines: number): boolean {
  if (
    start < 0 ||
    lines < 0 ||
    start > MAX_PATCH_LINE_COORDINATE ||
    lines > MAX_HUNK_LINE_COUNT
  )
    return false;
  return lines === 0 || start > 0;
}

function countHunkBody(
  tokens: ReadonlyArray<UnifiedPatchToken>,
  start: number,
  end: number,
): { readonly oldLines: number; readonly newLines: number } | undefined {
  let oldLines = 0;
  let newLines = 0;
  let sawContent = false;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== "body") return undefined;
    if (token.marker === "no_newline") {
      if (token.raw !== NO_NEWLINE_MARKER || !sawContent) return undefined;
      continue;
    }
    if (token.marker === "other") return undefined;
    if (token.marker !== "added") oldLines += 1;
    if (token.marker !== "removed") newLines += 1;
    sawContent = true;
  }
  return { oldLines, newLines };
}

function validHunkBody(
  tokens: ReadonlyArray<UnifiedPatchToken>,
  start: number,
  end: number,
  range: UnifiedHunkRange,
): boolean {
  const counted = countHunkBody(tokens, start, end);
  return (
    counted !== undefined &&
    counted.oldLines === range.oldLines &&
    counted.newLines === range.newLines
  );
}

/** Rejects malformed bodies and bounded-hunk violations without changing canonical aliases or source headers. */
export function parseNarrativePatch(
  patch: string,
): Result<NarrativePatch, InvalidNarrativePatch> {
  if (patch.length === 0) return invalid();
  const lines = (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n");
  const tokens = tokenizeUnifiedPatchLines(lines);
  const files: Array<{
    readonly start: number;
    prefixEnd: number | undefined;
    hunks: Array<{
      readonly start: number;
      end: number;
      header: string;
      range: UnifiedHunkRange;
      path: RepoRelativePath;
    }>;
  }> = [];
  let current: (typeof files)[number] | undefined;
  let currentPath: RepoRelativePath | undefined;
  let currentHunkStart: number | undefined;

  const finishHunk = (end: number): boolean => {
    if (
      current === undefined ||
      currentHunkStart === undefined ||
      currentPath === undefined
    )
      return true;
    const header = lines[currentHunkStart];
    const opener = tokens[currentHunkStart];
    if (header === undefined || opener?.kind !== "hunk_header") return false;
    if (!validHunkBody(tokens, currentHunkStart + 1, end, opener.range))
      return false;
    const raw = lines.slice(currentHunkStart, end).join("\n");
    if (raw.length > MAX_HUNK_RAW_LENGTH) return false;
    current.hunks.push({
      start: currentHunkStart,
      end,
      header,
      range: opener.range,
      path: currentPath,
    });
    currentHunkStart = undefined;
    return true;
  };

  for (const token of tokens) {
    if (token.kind === "file_header") {
      if (!finishHunk(token.index)) return invalid();
      const path = parseDiffPath(token.newPath ?? "");
      if (path._tag === "err") return path;
      current = { start: token.index, prefixEnd: undefined, hunks: [] };
      files.push(current);
      currentPath = path.value;
      continue;
    }
    // Bare git submodule-change lines are metadata, not hunk body.
    if (token.kind === "submodule") {
      if (!finishHunk(token.index)) return invalid();
      continue;
    }
    if (current === undefined) continue;
    if (token.kind === "hunk_header") {
      if (!validHunkRange(token.range)) return invalid();
      if (!finishHunk(token.index)) return invalid();
      current.prefixEnd ??= token.index;
      currentHunkStart = token.index;
      continue;
    }
    if (token.raw.startsWith("@@ ")) return invalid();
  }
  if (!finishHunk(lines.length)) return invalid();

  const parsedFiles: Array<NarrativePatch["files"][number]> = [];
  const parsedHunks: Array<NarrativePatchHunk> = [];
  let nextAlias = 1;
  for (const [ordinal, file] of files.entries()) {
    if (file.hunks.length === 0) continue;
    const prefixEnd = file.prefixEnd ?? file.hunks[0]?.start ?? file.start;
    const prefix = lines.slice(file.start, prefixEnd).join("\n");
    if (prefix.length > MAX_NARRATIVE_FILE_PREFIX_LENGTH) return invalid();
    const hunks: Array<NarrativePatchHunk> = [];
    for (const hunk of file.hunks) {
      const raw = lines
        .slice(hunk.start, hunk.end)
        .join("\n")
        .replace(/\n+$/, "");
      const parsed: NarrativePatchHunk = {
        id: `h${nextAlias}`,
        path: hunk.path,
        header: hunk.header,
        raw,
        oldStart: hunk.range.oldStart,
        oldLines: hunk.range.oldLines,
        newStart: hunk.range.newStart,
        newLines: hunk.range.newLines,
        filePrefix: prefix,
      };
      nextAlias += 1;
      hunks.push(parsed);
      parsedHunks.push(parsed);
    }
    parsedFiles.push({ ordinal, prefix, hunks });
  }

  return parsedHunks.length === 0
    ? invalid()
    : ok({ files: parsedFiles, hunks: parsedHunks });
}
