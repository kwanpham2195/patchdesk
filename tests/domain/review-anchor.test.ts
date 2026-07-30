import { describe, expect, it } from "vitest";

import { parseRepoRelativePath } from "../../src/domain/ids";
import {
  fingerprintPatchAnchor,
  matchPatchAnchor,
} from "../../src/domain/review-anchor";

const path = parseRepoRelativePath("src/example.ts");
if (path._tag === "err") throw new Error("Invalid test path");

const originalPatch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,5 +1,5 @@",
  " context before",
  "-old line",
  "+new line",
  " context after",
  " unchanged tail",
].join("\n");

describe("review anchor context", () => {
  it("matches a uniquely moved current-head line using exact context", () => {
    const fingerprint = fingerprintPatchAnchor(originalPatch, {
      path: path.value,
      startLine: 2,
      line: 2,
      side: "new",
    });

    expect(fingerprint).toMatchObject({
      selectedLines: ["new line"],
      before: ["context before"],
      after: ["context after", "unchanged tail"],
    });

    const currentPatch = originalPatch.replace(
      "@@ -1,5 +1,5 @@",
      "@@ -1,5 +1,6 @@",
    ).replace(
      " context before\n-old line",
      "+inserted before\n context before\n-old line",
    );
    const matches = fingerprint === undefined ? [] : matchPatchAnchor(currentPatch, fingerprint);

    expect(matches).toEqual([{
      path: path.value,
      startLine: 3,
      line: 3,
      side: "new",
    }]);
  });

  it("returns both candidates when the exact context is ambiguous", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,6 +1,6 @@",
      " context before",
      "+same line",
      " context after",
      " context before",
      "+same line",
      " context after",
    ].join("\n");
    expect(matchPatchAnchor(patch, {
      path: path.value,
      side: "new",
      startLine: 2,
      line: 2,
      selectedLines: ["same line"],
      before: [],
      after: [],
    })).toHaveLength(2);
  });
});
