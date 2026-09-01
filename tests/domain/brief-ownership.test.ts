import { describe, expect, it } from "vitest";

import {
  briefOwnershipFiles,
  normalizeBriefOwnership,
  type BriefOwnershipOutput,
} from "../../src/domain/brief-ownership";

/**
 * One patch that carries every status the skeleton reports, plus a lockfile so
 * the generated rule has something to drop. The files are written out of path
 * order so the ordering assertion means something.
 */
const PATCH = [
  "diff --git a/src/writer.ts b/src/writer.ts",
  "--- a/src/writer.ts",
  "+++ b/src/writer.ts",
  "@@ -1,2 +1,2 @@",
  " const kept = true;",
  "-const before = 1;",
  "+const after = 2;",
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
  "--- a/pnpm-lock.yaml",
  "+++ b/pnpm-lock.yaml",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/added.ts b/src/added.ts",
  "--- /dev/null",
  "+++ b/src/added.ts",
  "@@ -0,0 +1,2 @@",
  "+export const one = 1;",
  "+export const two = 2;",
  "diff --git a/src/removed.ts b/src/removed.ts",
  "--- a/src/removed.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const gone = true;",
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 90%",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "--- a/src/old-name.ts",
  "+++ b/src/new-name.ts",
  "@@ -1 +1 @@",
  "-const moved = 1;",
  "+const moved = 2;",
  "",
].join("\n");

function ownership(raw: BriefOwnershipOutput) {
  return normalizeBriefOwnership(raw, PATCH);
}

describe("briefOwnershipFiles", () => {
  it("reports one status per changed file and orders the skeleton by path", () => {
    expect(
      briefOwnershipFiles(PATCH).map((file) => [file.path, file.status]),
    ).toEqual([
      ["src/added.ts", "added"],
      ["src/new-name.ts", "renamed"],
      ["src/removed.ts", "removed"],
      ["src/writer.ts", "modified"],
    ]);
  });

  it("counts the added and removed lines of each file", () => {
    const added = briefOwnershipFiles(PATCH).find(
      (file) => file.path === "src/added.ts",
    );
    expect(added).toEqual({
      path: "src/added.ts",
      status: "added",
      additions: 2,
      deletions: 0,
    });
  });

  it("leaves out a generated file, because nobody owns a lockfile", () => {
    expect(briefOwnershipFiles(PATCH).map((file) => file.path)).not.toContain(
      "pnpm-lock.yaml",
    );
  });

  it("reads an unindexable patch as no changed file at all", () => {
    expect(briefOwnershipFiles("not a patch")).toEqual([]);
  });
});

describe("normalizeBriefOwnership", () => {
  it("gives the deterministic skeleton even when the model offered nothing", () => {
    const normalized = normalizeBriefOwnership(undefined, PATCH);
    expect(normalized.value.files).toHaveLength(4);
    expect(normalized.value.notes).toEqual([]);
    expect(normalized.rejected).toBe(0);
  });

  it("keeps a note whose path is one of the changed files", () => {
    const normalized = ownership({
      notes: [{ path: "src/writer.ts", note: "  owns the read-back  " }],
    });
    expect(normalized.value.notes).toEqual([
      { path: "src/writer.ts", note: "owns the read-back" },
    ]);
    expect(normalized.rejected).toBe(0);
  });

  it("drops a note on a path the diff does not touch, and counts the drop", () => {
    const normalized = ownership({
      notes: [
        { path: "src/absent.ts", note: "not in this patch" },
        { path: "pnpm-lock.yaml", note: "a generated file is not in the tree" },
      ],
    });
    expect(normalized.value.notes).toEqual([]);
    expect(normalized.rejected).toBe(2);
  });

  it("caps a note at 140 characters", () => {
    const normalized = ownership({
      notes: [{ path: "src/writer.ts", note: "n".repeat(200) }],
    });
    expect(normalized.value.notes[0]?.note).toHaveLength(140);
  });
});
