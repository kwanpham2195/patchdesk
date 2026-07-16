import { describe, expect, it } from "vitest";
import { mapFindingLocation, parseUnifiedPatch, toGitHubReviewCoordinates } from "../../src/domain/patch";

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
  });

  it("converts only same-side mapped ranges into GitHub coordinates", () => {
    expect(toGitHubReviewCoordinates({ mappingStatus: "mapped", postable: true, path: "src/a.ts", side: "new", line: 3 })).toEqual({ path: "src/a.ts", line: 3, side: "RIGHT" });
    expect(toGitHubReviewCoordinates({ mappingStatus: "mapped", postable: true, path: "src/a.ts", side: "old", line: 3 })).toEqual({ path: "src/a.ts", line: 3, side: "LEFT" });
    expect(toGitHubReviewCoordinates({ mappingStatus: "mapped", postable: true, path: "src/a.ts", side: "new", line: 4, startLine: 3 })).toEqual({ path: "src/a.ts", start_line: 3, start_side: "RIGHT", line: 4, side: "RIGHT" });
    expect(toGitHubReviewCoordinates({ mappingStatus: "unmapped", postable: false, path: "src/a.ts", side: "new", line: 3 })).toBeUndefined();
  });
});
