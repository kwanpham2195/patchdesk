import { describe, expect, it } from "vitest";

import { ReviewPatchIndex } from "../../src/services/review-patch-index";

describe("ReviewPatchIndex", () => {
  it("returns byte-exact slices and aliases both sides of a rename", () => {
    const patch = [
      "diff --git a/old name.ts b/new name.ts",
      "similarity index 90%",
      "rename from old name.ts",
      "rename to new name.ts",
      "--- a/old name.ts",
      "+++ b/new name.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "diff --git a/image.png b/image.png",
      "Binary files a/image.png and b/image.png differ",
      "",
    ].join("\n");
    const index = ReviewPatchIndex.create(patch);
    const expectedRename = patch.slice(
      0,
      patch.indexOf("diff --git a/image.png"),
    );

    expect(index.slice("old name.ts")).toBe(expectedRename);
    expect(index.slice("new name.ts")).toBe(expectedRename);
    expect(index.slice("image.png")).toBe(
      patch.slice(patch.indexOf("diff --git a/image.png")),
    );
    expect(index.slice("missing.ts")).toBeUndefined();
  });
});
