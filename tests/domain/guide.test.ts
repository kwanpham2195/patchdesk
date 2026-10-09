import { describe, expect, it } from "vitest";
import {
  buildGuideInventory,
  guideOthers,
  parseGuideModelOutput,
  parseRetainedGuide,
  retainGuide,
} from "#src/domain/guide";
import type { Result } from "#src/domain/result";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid Guide evidence");
  return result.value;
}

const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-deleted
diff --git a/icon.png b/icon.png
Binary files a/icon.png and b/icon.png differ
diff --git a/check.sh b/check.sh
old mode 100644
new mode 100755
`;
const inventory = must(buildGuideInventory(patch));
const group = {
  title: "Change recovery",
  explanation: "Restores the request.",
  files: [{ fileId: "f1", relevance: "Restores the saved request." }],
};

describe("Guide evidence and membership", () => {
  it("uses decoded header paths for a quoted rename", () => {
    const result = must(
      buildGuideInventory(
        'diff --git "a/old name.ts" "b/new name.ts"\nrename from "old name.ts"\nrename to "new name.ts"\n',
      ),
    );
    expect(result[0]?.oldPath).toBe("old name.ts");
    expect(result[0]?.newPath).toBe("new name.ts");
    expect(result[0]?.status).toBe("renamed");
  });
  it("includes complete text, rename, deletion, binary and metadata blocks in canonical order", () => {
    expect(
      inventory.map((file) => [
        file.id,
        file.oldPath,
        file.newPath,
        file.status,
        file.evidence,
        file.additions,
        file.deletions,
      ]),
    ).toEqual([
      ["f1", "a.ts", "a.ts", "modified", "text", 1, 1],
      ["f2", "old.ts", "new.ts", "renamed", "metadata", 0, 0],
      ["f3", "deleted.ts", "deleted.ts", "removed", "text", 0, 1],
      ["f4", "icon.png", "icon.png", "modified", "binary", 0, 0],
      ["f5", "check.sh", "check.sh", "modified", "metadata", 0, 0],
    ]);
    expect(inventory[4]?.metadata).toContain("new mode 100755");
  });
  it("allows repeated membership across groups and derives exactly the distinct remainder", () => {
    const result = must(
      retainGuide(
        {
          groups: [
            group,
            {
              ...group,
              title: "Support",
              files: [
                group.files[0],
                { fileId: "f2", relevance: "Moves the owner." },
              ],
            },
          ],
        },
        { patchText: patch, inventory },
      ),
    );
    expect(result.groups.map((entry) => entry.id)).toEqual(["g1", "g2"]);
    expect(guideOthers(result).map((file) => file.id)).toEqual([
      "f3",
      "f4",
      "f5",
    ]);
  });
  it.each([
    ["extra result authority", { groups: [group], Others: [] }],
    ["generated identity", { groups: [{ ...group, id: "g1" }] }],
    [
      "unknown file",
      {
        groups: [
          { ...group, files: [{ fileId: "f99", relevance: "Unknown" }] },
        ],
      },
    ],
    [
      "duplicate file",
      { groups: [{ ...group, files: [group.files[0], group.files[0]] }] },
    ],
    ["blank title", { groups: [{ ...group, title: " " }] }],
    ["blank explanation", { groups: [{ ...group, explanation: "\n" }] }],
    [
      "blank role",
      { groups: [{ ...group, files: [{ fileId: "f1", relevance: " " }] }] },
    ],
    ["long title", { groups: [{ ...group, title: "t".repeat(201) }] }],
    [
      "long explanation",
      { groups: [{ ...group, explanation: "e".repeat(4001) }] },
    ],
    [
      "long role",
      {
        groups: [
          { ...group, files: [{ fileId: "f1", relevance: "r".repeat(501) }] },
        ],
      },
    ],
    ["too many groups", { groups: Array.from({ length: 13 }, () => group) }],
    ["empty groups", { groups: [] }],
  ])("rejects %s without a partial result", (_scenario, raw) => {
    expect(parseGuideModelOutput(raw, inventory)._tag).toBe("err");
  });
  it("rejects changed embedded inventory and group identity on rehydration", () => {
    const result = must(
      retainGuide({ groups: [group] }, { patchText: patch, inventory }),
    );
    expect(
      parseRetainedGuide({
        ...result,
        inventory: result.inventory.slice(0, -1),
      })._tag,
    ).toBe("err");
    expect(
      parseRetainedGuide({
        ...result,
        groups: [{ ...result.groups[0], id: "g2" }],
      })._tag,
    ).toBe("err");
  });
  it("indexes every header in a many-file metadata-only patch", () => {
    const many = Array.from(
      { length: 3000 },
      (_, index) =>
        `diff --git a/f${index} b/f${index}\nold mode 100644\nnew mode 100755\n`,
    ).join("");
    const result = must(buildGuideInventory(many));
    expect(result).toHaveLength(3000);
    expect(result[2999]?.id).toBe("f3000");
  });
});
