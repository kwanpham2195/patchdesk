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

  it("does not read a handler call or an HTTP client call as a route", () => {
    const result = signals([
      edited(
        "internal/role/service.go",
        ["\treturn nil"],
        ["\treturn s.handler.Handle(ctx, cmd)"],
      ),
      edited(
        "src/client.ts",
        ["a"],
        ['const users = await api.get("/users");'],
      ),
    ]);
    expect(result.row("routes")?.count).toBe(0);
  });

  it("does not count a removed toString call as a removed assertion", () => {
    const result = signals([
      edited(
        "tests/label.test.ts",
        ["  const id = n.toString();", "  expect(id).toBe('1');"],
        ["  expect(String(n)).toBe('1');"],
      ),
    ]);
    expect(result.row("tests_weakened")?.count).toBe(0);
  });

  it("does not read new or moved snapshot files as weakened tests", () => {
    const names = ["a", "b", "c", "d", "e"];
    const result = signals([
      ...names.map((name) =>
        created(`src/__snapshots__/${name}.test.ts.snap`, [
          "exports[`x`] = 1;",
        ]),
      ),
      ...names.map((name) =>
        [
          `diff --git a/old/__snapshots__/${name}.snap b/new/__snapshots__/${name}.snap`,
          "similarity index 100%",
          `rename from old/__snapshots__/${name}.snap`,
          `rename to new/__snapshots__/${name}.snap`,
        ].join("\n"),
      ),
    ]);
    expect(result.row("tests_weakened")?.count).toBe(0);
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

  it("flags goroutines, channels, locks, and fan-out added to code, but not in tests or mocks", () => {
    const result = signals([
      edited(
        "internal/role/service.go",
        ["\treturn nil"],
        [
          "\tgo func() { s.refresh(ctx) }()",
          "\tvar mu sync.Mutex",
          "\tdone := make(chan struct{})",
        ],
      ),
      edited("src/load.ts", ["load();"], ["await Promise.all(jobs.map(run));"]),
      edited("tests/load.test.ts", ["a"], ["await Promise.all(cases);"]),
      edited(
        "internal/mocks/role.go",
        ["\treturn nil"],
        ["\tvar mu sync.Mutex"],
      ),
    ]);
    expect(result.row("concurrency")).toMatchObject({
      count: 4,
      paths: ["internal/role/service.go", "src/load.ts"],
    });
  });

  it("does not read a channel-like word, a selected value, or a go.mod line as concurrency", () => {
    const result = signals([
      edited(
        "internal/role/service.go",
        ["\treturn nil"],
        [
          "\t// change the role name",
          "\tselected := roles[0]",
          "\tgoroutines := count",
        ],
      ),
    ]);
    expect(result.row("concurrency")?.count).toBe(0);
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
