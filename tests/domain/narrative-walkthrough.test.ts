import { describe, expect, it } from "vitest";
import { parseNarrativePatch } from "#src/domain/narrative-patch";
import { filterNarrativePatchToHunks } from "#src/domain/narrative-walkthrough";
import { parseUnifiedPatch } from "#src/domain/patch";

const PATCH = [
  "diff --git a/src/recovery.ts b/src/recovery.ts",
  "index 1111111..2222222 100644",
  "--- a/src/recovery.ts",
  "+++ b/src/recovery.ts",
  "@@ -1,2 +1,3 @@",
  " const before = true;",
  "+const first = true;",
  " ",
  "@@ -20,2 +21,3 @@",
  " const middle = true;",
  "+const second = true;",
  " ",
  "diff --git a/tests/recovery.test.ts b/tests/recovery.test.ts",
  "index 3333333..4444444 100644",
  "--- a/tests/recovery.test.ts",
  "+++ b/tests/recovery.test.ts",
  "@@ -3,2 +3,3 @@",
  ' test("before", () => {',
  "+  expect(true).toBe(true);",
  " });",
  "",
].join("\n");

describe("captured narrative patch", () => {
  it("rejects malformed, invalid, oversized, and mismatched unified-diff ranges", () => {
    const cases = [
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -0,1 +1,3 @@"),
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -1,-2 +1,3 @@"),
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -1,1000001 +1,3 @@"),
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -1,3 +1,3 @@"),
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -1,2 +1,3 @@\n? malformed"),
    ];
    for (const [index, patch] of cases.entries()) {
      expect(
        parseNarrativePatch(patch),
        `invalid patch case ${index}`,
      ).toMatchObject({ _tag: "err", error: { reason: "invalid_patch" } });
    }
  });

  it("accepts valid zero-count ranges and preserves exact coordinates", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");
    const result = parseNarrativePatch(patch);
    expect(result._tag).toBe("ok");
    if (result._tag === "ok")
      expect(result.value.hunks[0]).toMatchObject({
        id: "h1",
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        filePrefix: expect.stringContaining("--- /dev/null"),
      });
  });

  it("filters reverse requested ids in source order and preserves the source patch", () => {
    const original = PATCH;
    const filtered = filterNarrativePatchToHunks(PATCH, ["h3", "h1"]);
    expect(filtered.indexOf("@@ -1,2 +1,3 @@")).toBeLessThan(
      filtered.indexOf("@@ -3,2 +3,3 @@"),
    );
    expect(parseUnifiedPatch(filtered)).toHaveLength(2);
    expect(PATCH).toBe(original);
  });

  it("filters a malformed patch to an empty result instead of exposing coordinates", () => {
    expect(
      filterNarrativePatchToHunks(
        PATCH.replace("@@ -1,2 +1,3 @@", "@@ -0,1 +1,3 @@"),
        ["h1"],
      ),
    ).toBe("");
  });

  it("tolerates bare git submodule metadata lines after the last hunk", () => {
    const patch = [
      "diff --git a/sql/000026_visit_route_planning.up.sql b/sql/000026_visit_route_planning.up.sql",
      "new file mode 100644",
      "index 00000000..8ffad242",
      "--- /dev/null",
      "+++ b/sql/000026_visit_route_planning.up.sql",
      "@@ -0,0 +1,2 @@",
      "+BEGIN;",
      "+COMMIT;",
      "Submodule yim-proto-hub 00000000...4619420d (new submodule)",
      "",
    ].join("\n");
    const result = parseNarrativePatch(patch);
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.hunks).toHaveLength(1);
      expect(result.value.hunks[0]?.path).toBe(
        "sql/000026_visit_route_planning.up.sql",
      );
    }
  });
});
