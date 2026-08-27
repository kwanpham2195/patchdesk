import { definedProps } from "./defined-props";
import type { FindingMappingStatus } from "./review-result";
import { tokenizeUnifiedPatch, type UnifiedPatchToken } from "./unified-patch";

export type ParsedPatchFile = {
  readonly oldPath: string;
  readonly newPath: string;
  readonly kind: "modified" | "renamed" | "binary" | "omitted";
  readonly oldLines: ReadonlySet<number>;
  readonly newLines: ReadonlySet<number>;
  readonly additions: number;
  readonly deletions: number;
};

export type FindingLocationInput = {
  readonly file?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly diffSide?: "new" | "old";
};
export type FindingLocation = {
  readonly mappingStatus: FindingMappingStatus;
  readonly postable: boolean;
  readonly path?: string;
  readonly side?: "new" | "old";
  readonly line?: number;
  readonly startLine?: number;
  readonly warning?: "binary" | "omitted";
};
export type GitHubReviewCoordinates = {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly start_line?: number;
  readonly start_side?: "LEFT" | "RIGHT";
};

/** One exact unified-diff hunk plus its original file header for read-only Finding evidence. */
export type FindingEvidenceHunk = {
  readonly patch: string;
  readonly path: string;
  readonly selectedRange: {
    readonly start: number;
    readonly end: number;
    readonly side: "new" | "old";
  };
};

/** Extracts a complete containing hunk without synthesizing or clipping diff content. */
export function extractFindingEvidenceHunk(
  patch: string,
  anchor: {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
  },
): FindingEvidenceHunk | undefined {
  if (anchor.startLine < 1 || anchor.line < anchor.startLine) return undefined;
  const lines = patch.split("\n");
  const tokens = tokenizeUnifiedPatch(patch);
  let file: Extract<UnifiedPatchToken, { kind: "file_header" }> | undefined;
  for (const token of tokens) {
    if (token.kind === "file_header") {
      file = token;
      continue;
    }
    if (file === undefined) continue;
    if (token.kind === "binary" || token.kind === "omitted") {
      file = undefined;
      continue;
    }
    if (token.kind !== "hunk_header") continue;
    let hunkEnd = token.index + 1;
    let containsStart = false;
    let containsEnd = false;
    for (; hunkEnd < tokens.length; hunkEnd += 1) {
      const body = tokens[hunkEnd];
      if (body === undefined) break;
      if (body.kind === "file_header" || body.raw.startsWith("@@ ")) break;
      if (body.kind !== "body" || body.marker === "no_newline") continue;
      const lineNumber = anchor.side === "new" ? body.newLine : body.oldLine;
      if (lineNumber === anchor.startLine) containsStart = true;
      if (lineNumber === anchor.line) containsEnd = true;
    }
    if (!containsStart || !containsEnd) continue;
    if (file.oldPath !== anchor.path && file.newPath !== anchor.path) continue;
    return {
      patch: lines.slice(file.index, hunkEnd).join("\n"),
      path: anchor.path,
      selectedRange: {
        start: anchor.startLine,
        end: anchor.line,
        side: anchor.side,
      },
    };
  }
  return undefined;
}

/** Parse only the unified-diff location metadata Patchdesk needs for navigation and write eligibility. */
export function parseUnifiedPatch(
  patch: string,
): ReadonlyArray<ParsedPatchFile> {
  const files: Array<{
    oldPath: string;
    newPath: string;
    kind: ParsedPatchFile["kind"];
    oldLines: Set<number>;
    newLines: Set<number>;
    additions: number;
    deletions: number;
  }> = [];
  let current: (typeof files)[number] | undefined;
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      const next = {
        oldPath: token.oldPath ?? "",
        newPath: token.newPath ?? "",
        kind: "modified" as const satisfies ParsedPatchFile["kind"],
        oldLines: new Set<number>(),
        newLines: new Set<number>(),
        additions: 0,
        deletions: 0,
      };
      current = next;
      files.push(next);
      continue;
    }
    if (current === undefined) continue;
    if (token.kind === "binary") current.kind = "binary";
    else if (token.kind === "omitted") current.kind = "omitted";
    else if (token.kind === "rename_from") {
      current.oldPath = token.path;
      current.kind = "renamed";
    } else if (token.kind === "rename_to") {
      current.newPath = token.path;
      current.kind = "renamed";
    } else if (token.kind === "body" && token.marker !== "no_newline") {
      if (token.oldLine !== undefined) current.oldLines.add(token.oldLine);
      if (token.newLine !== undefined) current.newLines.add(token.newLine);
      if (token.marker === "removed") current.deletions += 1;
      if (token.marker === "added") current.additions += 1;
    }
  }
  return files;
}

/** Map a model finding to an actual parsed hunk; unmapped or non-patch locations cannot be posted. */
export function mapFindingLocation(
  files: ReadonlyArray<ParsedPatchFile>,
  finding: FindingLocationInput,
): FindingLocation {
  if (finding.file === undefined || finding.lineStart === undefined)
    return { mappingStatus: "unmapped", postable: false };
  const file = files.find(
    (candidate) =>
      candidate.newPath === finding.file || candidate.oldPath === finding.file,
  );
  if (file === undefined) return { mappingStatus: "unmapped", postable: false };
  if (file.kind === "binary" || file.kind === "omitted")
    return { mappingStatus: "unmapped", postable: false, warning: file.kind };
  const side = finding.diffSide ?? "new";
  const lines = side === "new" ? file.newLines : file.oldLines;
  const end = finding.lineEnd ?? finding.lineStart;
  if (!lines.has(finding.lineStart) || !lines.has(end))
    return {
      mappingStatus: "invalid_line",
      postable: false,
      path: side === "new" ? file.newPath : file.oldPath,
      side,
      line: end,
      ...definedProps({
        startLine:
          finding.lineEnd === undefined ? undefined : finding.lineStart,
      }),
    };
  return {
    mappingStatus: "mapped",
    postable: true,
    path: side === "new" ? file.newPath : file.oldPath,
    side,
    line: end,
    ...definedProps({
      startLine: finding.lineEnd === undefined ? undefined : finding.lineStart,
    }),
  };
}

/** Convert an already-mapped same-side finding into GitHub's review-comment coordinate contract. */
export function toGitHubReviewCoordinates(
  location: FindingLocation,
): GitHubReviewCoordinates | undefined {
  if (
    !location.postable ||
    location.mappingStatus !== "mapped" ||
    location.path === undefined ||
    location.side === undefined ||
    location.line === undefined
  )
    return undefined;
  const side = location.side === "new" ? "RIGHT" : "LEFT";
  return location.startLine === undefined
    ? { path: location.path, line: location.line, side }
    : {
        path: location.path,
        start_line: location.startLine,
        start_side: side,
        line: location.line,
        side,
      };
}
