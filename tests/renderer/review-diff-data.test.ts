import { describe, expect, it } from "vitest";

import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";

describe("parseReviewDiff", () => {
  it("derives immutable per-file totals from additions, deletions, renames, and binary files", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " same",
      "-old",
      "+new",
      "+added",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "diff --git a/assets/blob.bin b/assets/blob.bin",
      "Binary files a/assets/blob.bin and b/assets/blob.bin differ",
    ].join("\n");

    const parsed = parseReviewDiff(patch);

    expect(parsed.statsByPath.get("src/a.ts")).toEqual({
      path: "src/a.ts",
      additions: 2,
      deletions: 1,
    });
    expect(parsed.statsByPath.get("src/new.ts")).toEqual({
      path: "src/new.ts",
      additions: 1,
      deletions: 1,
    });
    expect(parsed.statsByPath.get("assets/blob.bin")).toEqual({
      path: "assets/blob.bin",
      additions: 0,
      deletions: 0,
    });
    expect(parsed.gitStatusByPath.get("src/a.ts")).toBe("modified");
  });

  it("maps Pierre file change types to native tree git status", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/dev/null b/added.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.ts",
      "@@ -0,0 +1 @@",
      "+new",
      "diff --git a/deleted.ts b/dev/null",
      "deleted file mode 100644",
      "--- a/deleted.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
    ].join("\n");

    const parsed = parseReviewDiff(patch);

    expect(parsed.gitStatusByPath.get("new.ts")).toBe("renamed");
    expect(parsed.gitStatusByPath.get("added.ts")).toBe("added");
    expect(parsed.gitStatusByPath.get("deleted.ts")).toBe("deleted");
  });
});
