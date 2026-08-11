export type ParsedPatchFile = {
  readonly oldPath: string;
  readonly newPath: string;
  readonly kind: "modified" | "renamed" | "binary" | "omitted";
  readonly oldLines: ReadonlySet<number>;
  readonly newLines: ReadonlySet<number>;
  readonly additions: number;
  readonly deletions: number;
};

export type FindingLocationInput = { readonly file?: string; readonly lineStart?: number; readonly lineEnd?: number; readonly diffSide?: "new" | "old" };
export type FindingLocation = { readonly mappingStatus: "mapped" | "unmapped" | "invalid_line"; readonly postable: boolean; readonly path?: string; readonly side?: "new" | "old"; readonly line?: number; readonly startLine?: number; readonly warning?: "binary" | "omitted" };
export type GitHubReviewCoordinates = { readonly path: string; readonly line: number; readonly side: "LEFT" | "RIGHT"; readonly start_line?: number; readonly start_side?: "LEFT" | "RIGHT" };

/** One exact unified-diff hunk plus its original file header for read-only Finding evidence. */
export type FindingEvidenceHunk = {
  readonly patch: string;
  readonly path: string;
  readonly selectedRange: { readonly start: number; readonly end: number; readonly side: "new" | "old" };
};

/** Extracts a complete containing hunk without synthesizing or clipping diff content. */
export function extractFindingEvidenceHunk(
  patch: string,
  anchor: { readonly path: string; readonly startLine: number; readonly line: number; readonly side: "new" | "old" },
): FindingEvidenceHunk | undefined {
  if (anchor.startLine < 1 || anchor.line < anchor.startLine) return undefined;
  const lines = patch.split("\n");
  let fileStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileMatch !== null) { fileStart = index; continue; }
    if (fileStart < 0) continue;
    if (line === "GIT binary patch" || line.startsWith("Binary files ") || line.includes("diff too large")) { fileStart = -1; continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    let oldLine = Number(hunk[1]);
    let newLine = Number(hunk[3]);
    let hunkEnd = index + 1;
    let containsStart = false;
    let containsEnd = false;
    for (; hunkEnd < lines.length; hunkEnd += 1) {
      const hunkLine = lines[hunkEnd] ?? "";
      if (hunkLine.startsWith("diff --git ") || hunkLine.startsWith("@@ ")) break;
      if (hunkLine.startsWith("\\")) continue;
      const lineNumber = anchor.side === "new" ? newLine : oldLine;
      const present = anchor.side === "new" ? !hunkLine.startsWith("-") : !hunkLine.startsWith("+");
      if (present && lineNumber === anchor.startLine) containsStart = true;
      if (present && lineNumber === anchor.line) containsEnd = true;
      if (!hunkLine.startsWith("+")) oldLine += 1;
      if (!hunkLine.startsWith("-")) newLine += 1;
    }
    if (!containsStart || !containsEnd) continue;
    const header = lines.slice(fileStart, index);
    const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(header[0] ?? "");
    if (paths === null || (paths[1] !== anchor.path && paths[2] !== anchor.path)) continue;
    return { patch: [...header, ...lines.slice(index, hunkEnd)].join("\n"), path: anchor.path, selectedRange: { start: anchor.startLine, end: anchor.line, side: anchor.side } };
  }
  return undefined;
}

/** Parse only the unified-diff location metadata Patchdesk needs for navigation and write eligibility. */
export function parseUnifiedPatch(patch: string): ReadonlyArray<ParsedPatchFile> {
  const files: Array<{ oldPath: string; newPath: string; kind: ParsedPatchFile["kind"]; oldLines: Set<number>; newLines: Set<number>; additions: number; deletions: number }> = [];
  let current: (typeof files)[number] | undefined; let oldLine = 0; let newLine = 0; let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header !== null) { const next = { oldPath: header[1] ?? "", newPath: header[2] ?? "", kind: "modified" as const, oldLines: new Set<number>(), newLines: new Set<number>(), additions: 0, deletions: 0 }; current = next; files.push(next); inHunk = false; continue; }
    if (current === undefined) continue;
    if (line.startsWith("Binary files ")) { current.kind = "binary"; inHunk = false; continue; }
    if (line.startsWith("rename from ")) { current.oldPath = line.slice("rename from ".length); current.kind = "renamed"; continue; }
    if (line.startsWith("rename to ")) { current.newPath = line.slice("rename to ".length); current.kind = "renamed"; continue; }
    if (line === "GIT binary patch" || line.includes("diff too large")) { current.kind = "omitted"; inHunk = false; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("-")) { current.oldLines.add(oldLine); current.deletions += 1; oldLine += 1; continue; }
    if (line.startsWith("+")) { current.newLines.add(newLine); current.additions += 1; newLine += 1; continue; }
    current.oldLines.add(oldLine); current.newLines.add(newLine); oldLine += 1; newLine += 1;
  }
  return files;
}

/** Map a model finding to an actual parsed hunk; unmapped or non-patch locations cannot be posted. */
export function mapFindingLocation(files: ReadonlyArray<ParsedPatchFile>, finding: FindingLocationInput): FindingLocation {
  if (finding.file === undefined || finding.lineStart === undefined) return { mappingStatus: "unmapped", postable: false };
  const file = files.find((candidate) => candidate.newPath === finding.file || candidate.oldPath === finding.file);
  if (file === undefined) return { mappingStatus: "unmapped", postable: false };
  if (file.kind === "binary" || file.kind === "omitted") return { mappingStatus: "unmapped", postable: false, warning: file.kind };
  const side = finding.diffSide ?? "new"; const lines = side === "new" ? file.newLines : file.oldLines;
  const end = finding.lineEnd ?? finding.lineStart;
  if (!lines.has(finding.lineStart) || !lines.has(end)) return { mappingStatus: "invalid_line", postable: false, path: side === "new" ? file.newPath : file.oldPath, side, line: end, ...(finding.lineEnd === undefined ? {} : { startLine: finding.lineStart }) };
  return { mappingStatus: "mapped", postable: true, path: side === "new" ? file.newPath : file.oldPath, side, line: end, ...(finding.lineEnd === undefined ? {} : { startLine: finding.lineStart }) };
}

/** Convert an already-mapped same-side finding into GitHub's review-comment coordinate contract. */
export function toGitHubReviewCoordinates(location: FindingLocation): GitHubReviewCoordinates | undefined {
  if (!location.postable || location.mappingStatus !== "mapped" || location.path === undefined || location.side === undefined || location.line === undefined) return undefined;
  const side = location.side === "new" ? "RIGHT" : "LEFT";
  return location.startLine === undefined ? { path: location.path, line: location.line, side } : { path: location.path, start_line: location.startLine, start_side: side, line: location.line, side };
}
