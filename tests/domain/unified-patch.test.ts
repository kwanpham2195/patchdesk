import { describe, expect, it } from "vitest";
import { fingerprintPatchAnchor } from "../../src/domain/diff-anchor";
import {
  parseRepoRelativePath,
  type RepoRelativePath,
} from "../../src/domain/ids";
import { mapFindingLocation, parseUnifiedPatch } from "../../src/domain/patch";
import { ReviewPatchIndex } from "../../src/services/review-patch-index";
import {
  matchUnifiedFileHeader,
  tokenizeUnifiedPatch,
} from "../../src/domain/unified-patch";

function repoPath(value: string): RepoRelativePath {
  const parsed = parseRepoRelativePath(value);
  if (parsed._tag === "err") throw new Error(`unusable test path: ${value}`);
  return parsed.value;
}

const quotedHeaderPatch = `diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"
--- "a/we\\"ird.txt"
+++ "b/we\\"ird.txt"
@@ -1 +1 @@
-old
+new
diff --git a/plain.ts b/plain.ts
--- a/plain.ts
+++ b/plain.ts
@@ -1 +1 @@
-before
+after
`;

const markerLikeBodyPatch = `diff --git a/src/dash.ts b/src/dash.ts
--- a/src/dash.ts
+++ b/src/dash.ts
@@ -1,3 +1,3 @@
 first
--- fence
+++ fence
 last
`;

const strippedContextPatch = `diff --git a/src/blank.ts b/src/blank.ts
--- a/src/blank.ts
+++ b/src/blank.ts
@@ -1,3 +1,3 @@
 alpha

-gamma
+delta`;

const bannerBodyPatch = `diff --git a/src/note.ts b/src/note.ts
--- a/src/note.ts
+++ b/src/note.ts
@@ -1,2 +1,2 @@
 keep
-// the diff too large banner
+// the banner
`;

// Unedited `git diff` output: deleting a SQL comment and adding a marker puts a
// `--- ` and a `+++ ` line inside the hunk body, one deletion before three
// surviving lines.
const deletionPatch = `diff --git a/m.sql b/m.sql
--- a/m.sql
+++ b/m.sql
@@ -1,4 +1,4 @@
 SELECT 1;
--- drop the old table
+++ added marker
 SELECT 2;
 SELECT 3;
`;

// Unedited `git diff` output. The old file's last line `three` carried no
// trailing newline and was changed, so git emits `\ No newline at end of file`
// in the MIDDLE of the hunk — after the removed line, before the added ones.
// The marker occupies neither side, so every line after it keeps its numbers.
const midHunkNoNewlinePatch = `diff --git a/n.txt b/n.txt
index 54d55bf..725555c 100644
--- a/n.txt
+++ b/n.txt
@@ -1,3 +1,4 @@
 one
 two
-three
\\ No newline at end of file
+three-new
+four
`;

// Unedited `diff -u` output: no `diff --git` header, and both side paths carry
// a tab-separated timestamp that is not part of the path.
const timestampedSidePathPatch = `--- o.txt\t2026-08-27 21:10:24
+++ w.txt\t2026-08-27 21:10:24
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`;

const renamePatch = `diff --git a/src/old name.ts b/src/new name.ts
similarity index 92%
rename from src/old name.ts
rename to src/new name.ts
--- a/src/old name.ts
+++ b/src/new name.ts
@@ -1 +1 @@
-old
+new
`;

function bodyNumbers(
  patch: string,
): ReadonlyArray<readonly [string, number | undefined, number | undefined]> {
  return tokenizeUnifiedPatch(patch).flatMap((token) =>
    token.kind === "body"
      ? [[token.marker, token.oldLine, token.newLine] as const]
      : [],
  );
}

describe("UnifiedPatchTokenizer", () => {
  it("reads the quoted path form git emits for paths that need escaping", () => {
    const files = parseUnifiedPatch(quotedHeaderPatch);
    expect(files.map((file) => [file.oldPath, file.newPath])).toEqual([
      ['we"ird.txt', 'we"ird.txt'],
      ["plain.ts", "plain.ts"],
    ]);
  });

  it("decodes the octal escapes git uses for non-ASCII paths", () => {
    const tokens = tokenizeUnifiedPatch(
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    );
    expect(tokens[0]).toMatchObject({
      kind: "file_header",
      newPath: "café.txt",
    });
  });

  it("keeps byte slices aligned with parsed files across a quoted header", () => {
    const index = ReviewPatchIndex.create(quotedHeaderPatch);
    expect(index.slice("plain.ts")).toBe(
      `diff --git a/plain.ts b/plain.ts\n--- a/plain.ts\n+++ b/plain.ts\n@@ -1 +1 @@\n-before\n+after\n`,
    );
    expect(index.slice('we"ird.txt')).toBe(
      quotedHeaderPatch.slice(
        0,
        quotedHeaderPatch.indexOf("diff --git a/plain.ts"),
      ),
    );
  });

  it("treats body lines that begin with a path marker as ordinary changes", () => {
    const files = parseUnifiedPatch(markerLikeBodyPatch);
    expect(files[0]).toMatchObject({
      kind: "modified",
      additions: 1,
      deletions: 1,
    });
    expect(
      fingerprintPatchAnchor(markerLikeBodyPatch, {
        path: repoPath("src/dash.ts"),
        side: "new",
        startLine: 3,
        line: 3,
      }),
    ).toMatchObject({ selectedLines: ["last"] });
  });

  it("advances both sides for a context line whose leading space was stripped", () => {
    const files = parseUnifiedPatch(strippedContextPatch);
    expect([...(files[0]?.oldLines ?? [])]).toEqual([1, 2, 3]);
    const anchor = {
      path: repoPath("src/blank.ts"),
      side: "old" as const,
      startLine: 3,
      line: 3,
    };
    expect(fingerprintPatchAnchor(strippedContextPatch, anchor)).toMatchObject({
      selectedLines: ["gamma"],
    });
    expect(
      mapFindingLocation(files, {
        file: "src/blank.ts",
        lineStart: 3,
        diffSide: "old",
      }),
    ).toMatchObject({ mappingStatus: "mapped", line: 3 });
  });

  it("does not mistake a truncation banner inside a hunk for an omitted file", () => {
    expect(parseUnifiedPatch(bannerBodyPatch)[0]).toMatchObject({
      kind: "modified",
      additions: 1,
      deletions: 1,
    });
  });

  it("counts a removed line against the old side, so later lines keep their old numbers", () => {
    expect(bodyNumbers(deletionPatch)).toEqual([
      ["context", 1, 1],
      ["removed", 2, undefined],
      ["added", undefined, 2],
      ["context", 3, 3],
      ["context", 4, 4],
      // The empty string `split("\n")` yields after the closing newline, which
      // `parseUnifiedPatch` has always counted one past the last hunk line.
      ["other", 5, 5],
    ]);
    const files = parseUnifiedPatch(deletionPatch);
    expect([...(files[0]?.oldLines ?? [])]).toEqual([1, 2, 3, 4, 5]);
    expect(
      mapFindingLocation(files, {
        file: "m.sql",
        lineStart: 4,
        diffSide: "old",
      }),
    ).toMatchObject({ mappingStatus: "mapped", line: 4 });
    expect(
      fingerprintPatchAnchor(deletionPatch, {
        path: repoPath("m.sql"),
        side: "old",
        startLine: 3,
        line: 3,
      }),
    ).toMatchObject({ selectedLines: ["SELECT 2;"] });
  });

  it("gives a mid-hunk no-newline marker no line on either side, so later lines keep their numbers", () => {
    expect(bodyNumbers(midHunkNoNewlinePatch)).toEqual([
      ["context", 1, 1],
      ["context", 2, 2],
      ["removed", 3, undefined],
      // The marker is its own kind and occupies no line on either side.
      ["no_newline", undefined, undefined],
      ["added", undefined, 3],
      ["added", undefined, 4],
      // The empty string `split("\n")` yields after the closing newline.
      ["other", 4, 5],
    ]);
    const files = parseUnifiedPatch(midHunkNoNewlinePatch);
    expect(files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect([...(files[0]?.oldLines ?? [])]).toEqual([1, 2, 3, 4]);
    expect([...(files[0]?.newLines ?? [])]).toEqual([1, 2, 3, 4, 5]);
    // Counting the marker as a body line would shift both of these one high.
    expect(
      fingerprintPatchAnchor(midHunkNoNewlinePatch, {
        path: repoPath("n.txt"),
        side: "new",
        startLine: 3,
        line: 4,
      }),
    ).toMatchObject({ selectedLines: ["three-new", "four"] });
    expect(
      mapFindingLocation(files, {
        file: "n.txt",
        lineStart: 4,
        diffSide: "new",
      }),
    ).toMatchObject({ mappingStatus: "mapped", line: 4 });
  });

  it("drops the trailing timestamp `diff -u` puts on a `--- `/`+++ ` path", () => {
    expect(
      tokenizeUnifiedPatch(timestampedSidePathPatch).flatMap((token) =>
        token.kind === "old_file_path" || token.kind === "new_file_path"
          ? [[token.kind, token.path]]
          : [],
      ),
    ).toEqual([
      ["old_file_path", "o.txt"],
      ["new_file_path", "w.txt"],
    ]);
    // Keeping the stamp makes the path unmatchable, so the anchor never resolves.
    expect(
      fingerprintPatchAnchor(timestampedSidePathPatch, {
        path: repoPath("w.txt"),
        side: "new",
        startLine: 2,
        line: 2,
      }),
    ).toMatchObject({ selectedLines: ["BETA"] });
  });

  it("splits a header at its midpoint when a path of its own contains ` b/`", () => {
    expect(
      matchUnifiedFileHeader("diff --git a/a b/c d.txt b/a b/c d.txt"),
    ).toEqual({ oldPath: "a b/c d.txt", newPath: "a b/c d.txt" });
    expect(
      matchUnifiedFileHeader("diff --git a/mid b/dle.txt b/mid b/dle.txt"),
    ).toEqual({ oldPath: "mid b/dle.txt", newPath: "mid b/dle.txt" });
  });

  it("reads both sides of a rename from its own rename markers", () => {
    expect(
      tokenizeUnifiedPatch(renamePatch).flatMap((token) =>
        token.kind === "rename_from" || token.kind === "rename_to"
          ? [[token.kind, token.path]]
          : [],
      ),
    ).toEqual([
      ["rename_from", "src/old name.ts"],
      ["rename_to", "src/new name.ts"],
    ]);
    expect(parseUnifiedPatch(renamePatch)[0]).toMatchObject({
      kind: "renamed",
      oldPath: "src/old name.ts",
      newPath: "src/new name.ts",
    });
  });
});
