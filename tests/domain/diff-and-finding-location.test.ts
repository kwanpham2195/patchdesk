import { describe, expect, it } from "vitest";
import { extractFindingEvidenceHunk, mapFindingLocation, parseUnifiedPatch, toGitHubReviewCoordinates } from "../../src/domain/patch";

const patch = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,2 +2,3 @@
 old
-removed
+added
+next
 same
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/large.ts b/large.ts
--- a/large.ts
+++ b/large.ts
@@ -1 +1 @@
-old
+new
\\ No newline at end of file
`;

describe("PatchParser and FindingLocationMapper", () => {
  it("parses added, deleted, renamed, binary and omitted patch metadata", () => {
    const files = parseUnifiedPatch(patch);
    expect(files.map((file) => [file.oldPath, file.newPath, file.kind])).toEqual([
      ["src/a.ts", "src/a.ts", "modified"], ["old.ts", "new.ts", "renamed"], ["image.png", "image.png", "binary"], ["large.ts", "large.ts", "modified"],
    ]);
    expect(mapFindingLocation(files, { file: "src/a.ts", lineStart: 3, diffSide: "new" })).toMatchObject({ mappingStatus: "mapped", postable: true });
    expect(mapFindingLocation(files, { file: "src/a.ts", lineStart: 3, diffSide: "old" })).toMatchObject({ mappingStatus: "mapped", postable: true });
    expect(mapFindingLocation(files, { file: "src/a.ts", lineStart: 99, diffSide: "new" })).toMatchObject({ mappingStatus: "invalid_line", postable: false });
    expect(mapFindingLocation(files, { file: "missing.ts", lineStart: 1, diffSide: "new" })).toMatchObject({ mappingStatus: "unmapped", postable: false });
    expect(mapFindingLocation(files, { file: "image.png", lineStart: 1, diffSide: "new" })).toMatchObject({ mappingStatus: "unmapped", postable: false, warning: "binary" });
    const omitted = parseUnifiedPatch("diff --git a/large.ts b/large.ts\ndiff too large to display\n");
    expect(mapFindingLocation(omitted, { file: "large.ts", lineStart: 1, diffSide: "new" })).toEqual({ mappingStatus: "unmapped", postable: false, warning: "omitted" });
  });

  it("converts only same-side mapped ranges into GitHub coordinates", () => {
    expect(toGitHubReviewCoordinates({ mappingStatus: "mapped", postable: true, path: "src/a.ts", side: "new", line: 3 })).toEqual({ path: "src/a.ts", line: 3, side: "RIGHT" });
    expect(toGitHubReviewCoordinates({ mappingStatus: "mapped", postable: true, path: "src/a.ts", side: "old", line: 3 })).toEqual({ path: "src/a.ts", line: 3, side: "LEFT" });
    expect(toGitHubReviewCoordinates({ mappingStatus: "mapped", postable: true, path: "src/a.ts", side: "new", line: 4, startLine: 3 })).toEqual({ path: "src/a.ts", start_line: 3, start_side: "RIGHT", line: 4, side: "RIGHT" });
    expect(toGitHubReviewCoordinates({ mappingStatus: "unmapped", postable: false, path: "src/a.ts", side: "new", line: 3 })).toBeUndefined();
  });
});

describe("extractFindingEvidenceHunk", () => {
  it("returns the complete original file header and exact containing hunk", () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n one\n-two\n+two changed\n+three\n four\n@@ -10 +11 @@\n-old\n+new\n";
    expect(extractFindingEvidenceHunk(patch, { path: "src/a.ts", startLine: 2, line: 3, side: "new" })).toEqual({
      patch: "diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n one\n-two\n+two changed\n+three\n four",
      path: "src/a.ts",
      selectedRange: { start: 2, end: 3, side: "new" },
    });
  });

  it("refuses a range outside one represented hunk or a binary file", () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-old\n+new\n";
    expect(extractFindingEvidenceHunk(patch, { path: "src/a.ts", startLine: 1, line: 10, side: "new" })).toBeUndefined();
    expect(extractFindingEvidenceHunk("diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n", { path: "image.png", startLine: 1, line: 1, side: "new" })).toBeUndefined();
  });
});
