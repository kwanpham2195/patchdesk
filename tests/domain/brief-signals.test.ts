import { describe, expect, it } from "vitest";

import {
  BRIEF_SIGNAL_KINDS,
  briefSignals,
  type BriefSignalKind,
} from "../../src/domain/brief-signals";
import { listPatchChangedFiles } from "../../src/domain/patch-changed-files";

function edited(
  path: string,
  removed: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

function created(path: string, added: ReadonlyArray<string>): string {
  return [
    `diff --git a/${path} b/${path}`,
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

function deleted(path: string, removed: ReadonlyArray<string>): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${removed.length} +0,0 @@`,
    ...removed.map((line) => `-${line}`),
  ].join("\n");
}

function signals(
  sections: ReadonlyArray<string>,
  referenceUpdates: ReadonlyArray<string> = [],
) {
  const patch = `${sections.join("\n")}\n`;
  const rows = briefSignals(
    patch,
    listPatchChangedFiles(patch),
    referenceUpdates,
  );
  return {
    kinds: rows.map((row) => row.kind),
    row: (kind: BriefSignalKind) => rows.find((row) => row.kind === kind),
  };
}

describe("briefSignals", () => {
  it("returns every predefined row in order, at zero when nothing matched", () => {
    const result = signals([edited("src/label.ts", ["a"], ["b"])]);
    expect(result.kinds).toEqual([...BRIEF_SIGNAL_KINDS]);
    for (const kind of BRIEF_SIGNAL_KINDS.filter(
      (kind) => kind !== "skimmable",
    ))
      expect(result.row(kind)?.count).toBe(0);
  });

  it("lights each area from the paths that changed, and names a lockfile-only dependency change", () => {
    const result = signals([
      edited("api/v1/handler.go", ["a"], ["b"]),
      created("migrations/0007_add_role.sql", ["create table role ();"]),
      edited(".github/workflows/ci.yml", ["a"], ["b"]),
      edited("go.sum", ["a"], ["b"]),
      edited("Dockerfile", ["a"], ["b"]),
    ]);
    expect(result.row("public_api")?.paths).toEqual(["api/v1/handler.go"]);
    expect(result.row("stored_data")?.paths).toEqual([
      "migrations/0007_add_role.sql",
    ]);
    expect(result.row("security_boundary")?.paths).toEqual([
      ".github/workflows/ci.yml",
    ]);
    expect(result.row("dependencies")).toMatchObject({
      count: 1,
      detail: "lockfile only",
    });
    expect(result.row("config_or_deploy")?.paths).toEqual(["Dockerfile"]);
  });

  it("counts added and removed route registrations in code", () => {
    const result = signals([
      edited(
        "internal/router/router.go",
        ["\t// roles"],
        ['\tr.POST("/roles", h.Create)'],
      ),
      edited("src/server.ts", ['app.delete("/drafts/:id", remove);'], []),
    ]);
    expect(result.row("routes")).toMatchObject({
      count: 2,
      detail: "1 added · 1 removed",
    });
  });

  it("reads deleted tests, removed assertions, and focused or skipped tests as weakened", () => {
    const result = signals([
      deleted("tests/old.test.ts", ["it('works', () => {});"]),
      edited(
        "tests/label.test.ts",
        ["  expect(label).toBe('a');", "  expect(count).toBe(1);"],
        ["  it.only('runs alone', () => {});"],
      ),
    ]);
    expect(result.row("tests_weakened")).toMatchObject({
      count: 4,
      detail: "1 file deleted · 2 assertions removed · 1 skipped or focused",
    });
  });

  it("counts added test cases and new test files", () => {
    const result = signals([
      created("internal/role/service_test.go", [
        "func TestCreate(t *testing.T) {}",
        "func TestDelete(t *testing.T) {}",
      ]),
    ]);
    expect(result.row("tests_added")).toMatchObject({
      count: 2,
      detail: "1 new file",
    });
    expect(result.row("tests_weakened")?.count).toBe(0);
  });

  it("finds debug leftovers in code and ignores them in tests", () => {
    const result = signals([
      edited("src/sync.ts", ["run();"], ["console.log(state);", "run();"]),
      edited("tests/sync.test.ts", ["a"], ["console.log(result);"]),
    ]);
    expect(result.row("leftovers")).toMatchObject({
      count: 1,
      paths: ["src/sync.ts"],
    });
  });

  it("counts moved, move-following, and generated files as skimmable and raises nothing else for them", () => {
    const result = signals(
      [
        [
          "diff --git a/api/v1/a.go b/pkg/api/v1/a.go",
          "similarity index 100%",
          "rename from api/v1/a.go",
          "rename to pkg/api/v1/a.go",
        ].join("\n"),
        edited(
          "cmd/app/main.go",
          ['\t"example.com/svc/api/v1"'],
          ['\t"example.com/svc/pkg/api/v1"'],
        ),
      ],
      ["cmd/app/main.go"],
    );
    expect(result.row("skimmable")).toMatchObject({
      count: 2,
      detail: "the whole change",
    });
    expect(result.row("public_api")?.count).toBe(0);
  });
});
