import { describe, expect, it } from "vitest";

import {
  briefReachFiles,
  candidateReachSymbols,
  newlyDeclaredNames,
  removedSymbols,
  summarizeReach,
  surfacesCrossed,
  untestedReach,
} from "../../src/domain/brief-reach";

const patch = (...lines: ReadonlyArray<string>) => `${lines.join("\n")}\n`;

/** No head files: only names on changed lines can be found. */
const NO_HEAD: ReadonlyMap<string, ReadonlyArray<string>> = new Map();

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
    const withCall = patch(
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-  return loadThreads(id);",
      "+  return loadThreads(id, { fresh: true });",
    );
    expect(
      candidateReachSymbols(
        withCall,
        ["loadThreads", "somethingNeverInTheDiff"],
        NO_HEAD,
      ),
    ).toEqual(["loadThreads"]);
  });

  it("counts every exported name the patch declares even when the model leaves it out", () => {
    // Two runs of one PR once disagreed because one model list omitted a changed export.
    expect(
      candidateReachSymbols(WRITER_PATCH, ["CommentReadBack"], NO_HEAD),
    ).toEqual(["updateComment", "updateThreadComment", "CommentReadBack"]);
  });

  it("keeps the patch's own declarations before model-only names when the cap bites", () => {
    const wide = patch(
      "diff --git a/src/wide.ts b/src/wide.ts",
      "--- a/src/wide.ts",
      "+++ b/src/wide.ts",
      "@@ -1 +1,21 @@",
      "+const helper = loadThreads();",
      ...Array.from(
        { length: 20 },
        (_, index) => `+export const sym${String(index)} = 1;`,
      ),
    );
    const kept = candidateReachSymbols(wide, ["loadThreads"], NO_HEAD);
    expect(kept).toHaveLength(20);
    expect(kept).not.toContain("loadThreads");
  });

  it("rejects a name that is only part of a longer word in the diff", () => {
    expect(
      candidateReachSymbols(WRITER_PATCH, ["updateThread"], NO_HEAD),
    ).not.toContain("updateThread");
  });

  it("rejects anything that is not a plausible identifier", () => {
    // Nothing proposed survives the syntax rule, so the patch's own exported
    // declarations stand in -- none of the proposed strings reaches the block.
    expect(
      candidateReachSymbols(
        WRITER_PATCH,
        ["update Thread Comment", "1updateThreadComment", "u", "x".repeat(81)],
        NO_HEAD,
      ),
    ).toEqual(["updateComment", "updateThreadComment", "CommentReadBack"]);
  });

  it("dedupes and caps the kept names at twenty", () => {
    const wide = patch(
      "diff --git a/src/wide.ts b/src/wide.ts",
      "--- a/src/wide.ts",
      "+++ b/src/wide.ts",
      "@@ -1 +1,25 @@",
      ...Array.from(
        { length: 25 },
        (_, index) => `+export const sym${index} = 1;`,
      ),
    );
    const proposed = [
      ...Array.from({ length: 25 }, (_, index) => `sym${index}`),
      "sym0",
    ];
    const kept = candidateReachSymbols(wide, proposed, NO_HEAD);
    expect(kept).toHaveLength(20);
    expect(new Set(kept).size).toBe(20);
  });

  it("falls back to the patch's own exported declarations when nothing is proposed", () => {
    expect(candidateReachSymbols(WRITER_PATCH, [], NO_HEAD)).toEqual([
      "updateComment",
      "updateThreadComment",
      "CommentReadBack",
    ]);
  });

  it("falls back when every proposed name is rejected", () => {
    expect(
      candidateReachSymbols(WRITER_PATCH, ["notInTheDiff"], NO_HEAD),
    ).toEqual(["updateComment", "updateThreadComment", "CommentReadBack"]);
  });
});

describe("candidateReachSymbols with head files", () => {
  const REFRESH_PATH = "src/services/review-refresh-service.ts";
  const REFRESH_HEAD = [
    'import { loadReview } from "./review-store";',
    "",
    "function localHelper(id: string) {",
    "  return id.trim();",
    "}",
    "",
    "export class ReviewRefreshService {",
    "  async refresh(id: string) {",
    "    const review = await loadReview(localHelper(id));",
    "    return review;",
    "  }",
    "}",
  ];
  const head = new Map([[REFRESH_PATH, REFRESH_HEAD]]);
  /** A one-line body edit at `line` (1-based head line) that leaves every declaration line alone. */
  const bodyEdit = (line: number) =>
    patch(
      `diff --git a/${REFRESH_PATH} b/${REFRESH_PATH}`,
      `--- a/${REFRESH_PATH}`,
      `+++ b/${REFRESH_PATH}`,
      `@@ -${String(line)} +${String(line)} @@`,
      "-    const review = loadReview(id);",
      `+${REFRESH_HEAD[line - 1] ?? ""}`,
    );

  it("counts an exported class whose method body the patch changes as an existing name", () => {
    const edit = bodyEdit(9);
    expect(candidateReachSymbols(edit, [], head)).toEqual([
      "ReviewRefreshService",
    ]);
    expect(newlyDeclaredNames(edit).has("ReviewRefreshService")).toBe(false);
  });

  it("counts nothing for a changed line inside a function that is not exported", () => {
    expect(candidateReachSymbols(bodyEdit(4), [], head)).toEqual([]);
  });

  it.each([
    {
      name: "a removal inside one exported body counts that export",
      hunk: [
        "@@ -8,2 +8,1 @@",
        "   async refresh(id: string) {",
        "-    audit(id);",
      ],
      expected: ["ReviewRefreshService"],
    },
    {
      name: "a function removed after an exported class does not count the class",
      hunk: [
        "@@ -12,5 +12,1 @@",
        " }",
        "-",
        "-function dropped() {",
        "-  return 1;",
        "-}",
      ],
      expected: [],
    },
  ])("$name", ({ hunk, expected }) => {
    const removal = patch(
      `diff --git a/${REFRESH_PATH} b/${REFRESH_PATH}`,
      `--- a/${REFRESH_PATH}`,
      `+++ b/${REFRESH_PATH}`,
      ...hunk,
    );
    expect(candidateReachSymbols(removal, [], head)).toEqual(expected);
  });

  it.each([
    {
      path: "internal/refresh.go",
      declaration: "func (s *Service) Refresh(id string) error {",
      expected: ["Refresh"],
    },
    {
      path: "internal/refresh.go",
      declaration: "func refresh(id string) error {",
      expected: [],
    },
    {
      path: "app/refresh.py",
      declaration: "def refresh(review_id):",
      expected: ["refresh"],
    },
    {
      path: "app/refresh.py",
      declaration: "def _refresh(review_id):",
      expected: [],
    },
  ])(
    "reads the export rule of $path for $declaration",
    ({ path, declaration, expected }) => {
      const bodyChange = patch(
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -2 +2 @@",
        "-    return nil",
        "+    return load(id)",
      );
      const lines = [declaration, "    return load(id)"];
      expect(
        candidateReachSymbols(bodyChange, [], new Map([[path, lines]])),
      ).toEqual(expected);
    },
  );

  it("orders declared names, then enclosing exports, then model-only names under the cap", () => {
    const declared = Array.from(
      { length: 19 },
      (_, index) => `+export const sym${String(index)} = 1;`,
    );
    const mixed = patch(
      `diff --git a/${REFRESH_PATH} b/${REFRESH_PATH}`,
      `--- a/${REFRESH_PATH}`,
      `+++ b/${REFRESH_PATH}`,
      "@@ -9 +9 @@",
      "-    const review = loadReview(id);",
      `+${REFRESH_HEAD[8] ?? ""}`,
      "diff --git a/src/wide.ts b/src/wide.ts",
      "--- a/src/wide.ts",
      "+++ b/src/wide.ts",
      "@@ -1 +1,20 @@",
      "+const helper = loadReview();",
      ...declared,
    );
    const kept = candidateReachSymbols(mixed, ["loadReview"], head);
    expect(kept).toHaveLength(20);
    expect(kept.slice(0, 19)).toEqual(
      Array.from({ length: 19 }, (_, index) => `sym${String(index)}`),
    );
    expect(kept[19]).toBe("ReviewRefreshService");
    expect(kept).not.toContain("loadReview");
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

describe("newlyDeclaredNames", () => {
  it("reads a name declared only on added lines as new and one declared on a removed line as existing", () => {
    const rewritten = patch(
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      "-export function keep() { return 0; }",
      "+export function keep() { return 1; }",
      "+export type RefreshOperationStatus = 'running' | 'done';",
    );
    const fresh = newlyDeclaredNames(rewritten);
    expect(fresh.has("RefreshOperationStatus")).toBe(true);
    expect(fresh.has("keep")).toBe(false);
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

  it("lights Public API for a versioned Go package path", () => {
    expect(surfacesCrossed(["pkg/model/crm/v1/route-planning.go"])[0]).toEqual({
      surface: "Public API",
      path: "pkg/model/crm/v1/route-planning.go",
    });
  });

  it("lights Network write path for a Go adapter handler path", () => {
    expect(
      surfacesCrossed([
        "internal/adapter/http-server/route-planning-hdl/generate-suggestion.go",
      ])[4],
    ).toEqual({
      surface: "Network write path",
      path: "internal/adapter/http-server/route-planning-hdl/generate-suggestion.go",
    });
  });

  it("lights Stored data for a Go repository path", () => {
    expect(
      surfacesCrossed(["internal/core/route-planning-repo/update-plan.go"])[2],
    ).toEqual({
      surface: "Stored data",
      path: "internal/core/route-planning-repo/update-plan.go",
    });
  });

  it("stays unlit on every surface for a plain docs path", () => {
    expect(surfacesCrossed(["docs/x.md"])).toEqual([
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

  it("never reports a docs or config file as untested", () => {
    expect(
      untestedReach([
        { path: "CHANGELOG.md", changedText: "- Blast radius" },
        { path: "docs/adr/0046-blast-radius.md", changedText: "# 46" },
        {
          path: "docs/product-description/review-workbench/brief.md",
          changedText: "Blast radius",
        },
        { path: ".oxlintrc.json", changedText: "{}" },
        { path: "src/writer.ts", changedText: "export const a = 1;" },
      ]),
    ).toEqual([{ path: "src/writer.ts", reason: "no_test_in_pr" }]);
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

  it("matches a Go production file to its test across a hyphen/underscore separator", () => {
    expect(
      untestedReach([
        {
          path: "internal/core/route-planning-repo/update-plan.go",
          changedText:
            "func insertMutationStops(stops []Stop) error { return nil }",
        },
        {
          path: "internal/core/route-planning-repo/update_plan_test.go",
          changedText:
            "func TestInsertMutationStops(t *testing.T) { execCount := 1 }",
        },
      ]),
    ).toEqual([]);
  });

  it("clears a production file by a same-directory test named after something else", () => {
    expect(
      untestedReach([
        {
          path: "internal/adapter/http-server/route-planning-hdl/generate-suggestion.go",
          changedText: "func GenerateSuggestion() {}",
        },
        {
          path: "internal/adapter/http-server/route-planning-hdl/list_customers_test.go",
          changedText:
            "func TestListCustomersHandlerMapsStoreNotAllowedToForbidden(t *testing.T) {}",
        },
      ]),
    ).toEqual([]);
  });

  it("reports a production file with no test in its directory and no name match", () => {
    expect(
      untestedReach([
        {
          path: "internal/core/route-planning-repo/read-plans.go",
          changedText: "func setCurrentFirstCustomer() {}",
        },
        {
          path: "internal/adapter/http-server/route-planning-hdl/list_customers_test.go",
          changedText: "func TestListCustomers(t *testing.T) {}",
        },
      ]),
    ).toEqual([
      {
        path: "internal/core/route-planning-repo/read-plans.go",
        reason: "no_test_in_pr",
      },
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
          status: "new",
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
