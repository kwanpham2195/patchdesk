import { describe, expect, it } from "vitest";

import {
  briefReachFiles,
  candidateReachSymbols,
  removedSymbols,
  summarizeReach,
  surfacesCrossed,
  untestedReach,
} from "../../src/domain/brief-reach";

const patch = (...lines: ReadonlyArray<string>) => `${lines.join("\n")}\n`;

const WRITER_PATCH = patch(
  "diff --git a/src/adapters/github-thread-writer.ts b/src/adapters/github-thread-writer.ts",
  "--- a/src/adapters/github-thread-writer.ts",
  "+++ b/src/adapters/github-thread-writer.ts",
  "@@ -1,4 +1,5 @@",
  "-export function updateComment(id: string) {",
  "+export function updateThreadComment(id: string) {",
  "   return id;",
  " }",
  "+export type CommentReadBack = { id: string };",
);

describe("candidateReachSymbols", () => {
  it("keeps a proposed name only when the patch changed a line carrying it", () => {
    expect(
      candidateReachSymbols(WRITER_PATCH, [
        "updateThreadComment",
        "CommentReadBack",
        "somethingNeverInTheDiff",
      ]),
    ).toEqual(["updateThreadComment", "CommentReadBack"]);
  });

  it("rejects a name that is only part of a longer word in the diff", () => {
    expect(candidateReachSymbols(WRITER_PATCH, ["updateThread"])).not.toContain(
      "updateThread",
    );
  });

  it("rejects anything that is not a plausible identifier", () => {
    // Nothing proposed survives the syntax rule, so the patch's own exported
    // declarations stand in -- none of the proposed strings reaches the block.
    expect(
      candidateReachSymbols(WRITER_PATCH, [
        "update Thread Comment",
        "1updateThreadComment",
        "u",
        "x".repeat(81),
      ]),
    ).toEqual(["updateComment", "updateThreadComment", "CommentReadBack"]);
  });

  it("dedupes and caps the kept names at twelve", () => {
    const wide = patch(
      "diff --git a/src/wide.ts b/src/wide.ts",
      "--- a/src/wide.ts",
      "+++ b/src/wide.ts",
      "@@ -1 +1,20 @@",
      ...Array.from(
        { length: 20 },
        (_, index) => `+export const sym${index} = 1;`,
      ),
    );
    const proposed = [
      ...Array.from({ length: 20 }, (_, index) => `sym${index}`),
      "sym0",
    ];
    const kept = candidateReachSymbols(wide, proposed);
    expect(kept).toHaveLength(12);
    expect(new Set(kept).size).toBe(12);
  });

  it("falls back to the patch's own exported declarations when nothing is proposed", () => {
    expect(candidateReachSymbols(WRITER_PATCH, [])).toEqual([
      "updateComment",
      "updateThreadComment",
      "CommentReadBack",
    ]);
  });

  it("falls back when every proposed name is rejected", () => {
    expect(candidateReachSymbols(WRITER_PATCH, ["notInTheDiff"])).toEqual([
      "updateComment",
      "updateThreadComment",
      "CommentReadBack",
    ]);
  });
});

describe("removedSymbols", () => {
  it("keeps a removed declaration that never reappears on an added line", () => {
    expect(removedSymbols(WRITER_PATCH)).toEqual(["updateComment"]);
  });

  it("drops a declaration the same patch adds back", () => {
    const renamedBody = patch(
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-export function keep() { return 0; }",
      "+export function keep() { return 1; }",
    );
    expect(removedSymbols(renamedBody)).toEqual([]);
  });
});

describe("surfacesCrossed", () => {
  it("lights each surface with the first path that matched and leaves the rest unlit", () => {
    expect(
      surfacesCrossed([
        "src/adapters/github/github-thread-writer.ts",
        "src/index.ts",
        "migrations/0007-add-threads.sql",
      ]),
    ).toEqual([
      { surface: "Public API", path: "src/index.ts" },
      { surface: "CLI" },
      { surface: "Stored data", path: "migrations/0007-add-threads.sql" },
      { surface: "Security boundary" },
      {
        surface: "Network write path",
        path: "src/adapters/github/github-thread-writer.ts",
      },
    ]);
  });

  it("reads a workflow file and a credential module as the security boundary", () => {
    expect(surfacesCrossed([".github/workflows/ci.yml"])[3]).toEqual({
      surface: "Security boundary",
      path: ".github/workflows/ci.yml",
    });
    expect(surfacesCrossed(["src/github-credentials.ts"])[3]).toEqual({
      surface: "Security boundary",
      path: "src/github-credentials.ts",
    });
  });

  it("reports every surface even when no path matched any of them", () => {
    expect(surfacesCrossed(["src/renderer/src/app.tsx"])).toEqual([
      { surface: "Public API" },
      { surface: "CLI" },
      { surface: "Stored data" },
      { surface: "Security boundary" },
      { surface: "Network write path" },
    ]);
  });
});

describe("untestedReach", () => {
  it("clears a changed file a changed test names, and reports one it does not", () => {
    expect(
      untestedReach([
        { path: "src/label-service.ts", changedText: "export const a = 1;" },
        { path: "src/assignee-service.ts", changedText: "export const b = 2;" },
        {
          path: "tests/label-service.test.ts",
          changedText: 'import "../src/label-service";',
        },
      ]),
    ).toEqual([{ path: "src/assignee-service.ts", reason: "no_test_in_pr" }]);
  });

  it("never reports a test file or a generated file as untested", () => {
    expect(
      untestedReach([
        { path: "pnpm-lock.yaml", changedText: "+ lockfileVersion" },
        { path: "tests/only.test.ts", changedText: "" },
      ]),
    ).toEqual([]);
  });

  it("reads a Go _test.go file as the test, not as untested code", () => {
    expect(
      untestedReach([
        {
          path: "internal/cache/refresh_cache.go",
          changedText: "func RefreshCache() {}",
        },
        {
          path: "internal/repository/repository.go",
          changedText: "func FindRolePermission() {}",
        },
        {
          path: "internal/cache/refresh_cache_test.go",
          changedText: "func TestRefreshCache(t *testing.T) {}",
        },
      ]),
    ).toEqual([
      { path: "internal/repository/repository.go", reason: "no_test_in_pr" },
    ]);
  });
});

describe("briefReachFiles", () => {
  it("carries each changed file's added and removed lines and nothing else", () => {
    expect(briefReachFiles(WRITER_PATCH)).toEqual([
      {
        path: "src/adapters/github-thread-writer.ts",
        changedText: [
          "export function updateComment(id: string) {",
          "export function updateThreadComment(id: string) {",
          "export type CommentReadBack = { id: string };",
        ].join("\n"),
      },
    ]);
  });
});

describe("summarizeReach", () => {
  it("labels the block as a one-hop text match and never as a call graph", () => {
    const summary = summarizeReach({
      files: briefReachFiles(WRITER_PATCH),
      symbols: [
        {
          name: "updateThreadComment",
          outsideCallerFiles: 2,
          outsidePaths: ["src/main/local-api.ts"],
          insidePR: true,
        },
      ],
      removedStillReferenced: [
        { name: "updateComment", paths: ["src/main/local-api.ts"] },
      ],
    });
    expect(summary.method).toBe("text_match");
    expect(summary.hop).toBe(1);
    expect(summary.symbols).toHaveLength(1);
    expect(summary.removedStillReferenced).toHaveLength(1);
    expect(summary.untested).toEqual([
      { path: "src/adapters/github-thread-writer.ts", reason: "no_test_in_pr" },
    ]);
    expect(summary.surfaces.map((surface) => surface.surface)).toEqual([
      "Public API",
      "CLI",
      "Stored data",
      "Security boundary",
      "Network write path",
    ]);
  });
});
