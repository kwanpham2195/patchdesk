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
