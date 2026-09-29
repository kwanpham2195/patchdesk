import { describe, expect, it } from "vitest";

import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import {
  adjacentFindMatch,
  findDiffMatches,
} from "../../src/renderer/src/review-diff-find";

// The hunk header's function context names `tokenHeader`; it must never match.
const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ function tokenHeader()
 const token = 1;
-const oldToken = 2;
+const newTOKEN = 2;
 const other = 3;
@@ -10,2 +10,3 @@
 keep();
+token();
 end();
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,2 +5,1 @@
-dropToken();
 stay();
`;

function located(matches: ReturnType<typeof findDiffMatches>) {
  return matches.map(({ path, lineType, side, lineNumber }) => ({
    path,
    lineType,
    side,
    lineNumber,
  }));
}

describe("findDiffMatches", () => {
  it("finds removed, added, and unchanged patch lines in file and line order, ignoring case and hunk headers", () => {
    const { files } = parseReviewDiff(patch);

    const matches = findDiffMatches(files, "token");

    expect(located(matches)).toEqual([
      {
        path: "src/a.ts",
        lineType: "context",
        side: "additions",
        lineNumber: 1,
      },
      {
        path: "src/a.ts",
        lineType: "change-deletion",
        side: "deletions",
        lineNumber: 2,
      },
      {
        path: "src/a.ts",
        lineType: "change-addition",
        side: "additions",
        lineNumber: 2,
      },
      {
        path: "src/a.ts",
        lineType: "change-addition",
        side: "additions",
        lineNumber: 11,
      },
      {
        path: "src/b.ts",
        lineType: "change-deletion",
        side: "deletions",
        lineNumber: 5,
      },
    ]);
    expect(matches[0]?.oldLineNumber).toBe(1);
  });

  it("follows the order of the files it is given, which is the order the Diff draws them", () => {
    const { files } = parseReviewDiff(patch);

    const matches = findDiffMatches([...files].reverse(), "token");

    expect(matches.map((match) => match.path)).toEqual([
      "src/b.ts",
      "src/a.ts",
      "src/a.ts",
      "src/a.ts",
      "src/a.ts",
    ]);
  });

  it("gives an unchanged line its old-file number when the hunk moved it", () => {
    const { files } = parseReviewDiff(patch);

    const [stay] = findDiffMatches(files, "stay()");

    expect(stay).toMatchObject({
      path: "src/b.ts",
      lineType: "context",
      lineNumber: 5,
      oldLineNumber: 6,
    });
  });

  it("finds nothing for an empty query", () => {
    expect(findDiffMatches(parseReviewDiff(patch).files, "")).toEqual([]);
  });
});

describe("adjacentFindMatch", () => {
  it.each([
    ["Enter before any step lands on the first", undefined, "next", 0, false],
    [
      "Shift+Enter before any step lands on the last",
      undefined,
      "previous",
      2,
      false,
    ],
    ["Enter steps forward", 0, "next", 1, false],
    ["Enter on the last wraps to the first", 2, "next", 0, true],
    ["Shift+Enter on the first wraps to the last", 0, "previous", 2, true],
  ] as const)("%s", (_name, current, direction, index, wrapped) => {
    expect(adjacentFindMatch(3, current, direction)).toEqual({
      index,
      wrapped,
    });
  });

  it("has no target when nothing matches", () => {
    expect(adjacentFindMatch(0, undefined, "next")).toBeUndefined();
  });
});
