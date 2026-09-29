import { describe, expect, it } from "vitest";

import { diffLineRangeLocation } from "../../src/renderer/src/review-diff-line-range";

// Renamed and modified: the diff shows the file as src/new.ts, and its old-side lines belong to src/old.ts.
const RENAMED_PATCH = [
  "diff --git a/src/old.ts b/src/new.ts",
  "similarity index 60%",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -1,4 +1,4 @@",
  " line 1",
  "-old 2",
  "-old 3",
  "+new 2",
  "+new 3",
  " line 4",
  "",
].join("\n");

describe("diffLineRangeLocation", () => {
  it.each([
    { side: "deletions", saved: "old" },
    { side: "additions", saved: "new" },
  ] as const)(
    "keeps a $side range of a renamed file inside its one hunk",
    ({ side, saved }) => {
      expect(
        diffLineRangeLocation(RENAMED_PATCH, "src/new.ts", {
          start: 2,
          end: 3,
          side,
        }),
      ).toEqual({
        _tag: "ok",
        location: { path: "src/new.ts", startLine: 2, line: 3, side: saved },
      });
    },
  );
});
