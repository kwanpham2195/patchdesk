import { describe, expect, it } from "vitest";

import { countMoveReferenceUpdates } from "../../src/domain/move-reference-updates";
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

function rename(from: string, to: string): string {
  return [
    `diff --git a/${from} b/${to}`,
    "similarity index 100%",
    `rename from ${from}`,
    `rename to ${to}`,
  ].join("\n");
}

/** Every case moves `shared/mocks/` and `shared/run.ts`, so imports into them follow a move. */
function count(...sections: ReadonlyArray<string>): number {
  const patch = `${[
    rename("shared/mocks/repo.go", "internal/bulkupdate/mocks/repo.go"),
    rename("src/shared/run.ts", "src/core/run.ts"),
    ...sections,
  ].join("\n")}\n`;
  return countMoveReferenceUpdates(patch, listPatchChangedFiles(patch));
}

describe("countMoveReferenceUpdates", () => {
  it("counts a Go file whose import moved and whose code follows the renamed qualifier", () => {
    expect(
      count(
        edited(
          "api/handler_test.go",
          [
            '\tsharedmocks "example.com/svc/shared/mocks"',
            "\trepo := sharedmocks.NewBulkUpdateRepository(t)",
          ],
          [
            '\tbulkupdatemocks "example.com/svc/internal/bulkupdate/mocks"',
            "\trepo := bulkupdatemocks.NewBulkUpdateRepository(t)",
          ],
        ),
      ),
    ).toBe(1);
  });

  it("counts a module file whose relative import now resolves into the moved directory", () => {
    expect(
      count(
        edited(
          "src/app/main.ts",
          ['import { run } from "../shared/run";'],
          ['import { run } from "../core/run";'],
        ),
      ),
    ).toBe(1);
  });

  it("does not count a file that reorders its code next to a moved import", () => {
    expect(
      count(
        edited(
          "src/app/main.ts",
          [
            'import { run } from "../shared/run";',
            "validate(x);",
            "store.put(x);",
          ],
          [
            'import { run } from "../core/run";',
            "store.put(x);",
            "validate(x);",
          ],
        ),
      ),
    ).toBe(0);
  });

  it("does not count a file that only adds an import or an export", () => {
    expect(
      count(
        edited("src/index.ts", [], ['export { run } from "./core/run";']),
        edited("cmd/main.go", [], ['import _ "net/http/pprof"']),
      ),
    ).toBe(0);
  });

  it("does not count an import swap that points nowhere a file moved to", () => {
    expect(
      count(
        edited(
          "src/app/main.ts",
          ['import { log } from "../logging/log";'],
          ['import { log } from "../telemetry/log";'],
        ),
      ),
    ).toBe(0);
  });

  it("does not count a changed exported string, a JSON list, or a behavior change next to an import", () => {
    expect(
      count(
        edited(
          "src/config.ts",
          ['export const root = "./old";'],
          ['export const root = "./new";'],
        ),
        edited("tsconfig.json", ['    "src"'], ['    "lib"']),
        edited(
          "api/service.go",
          [
            '\t"example.com/svc/shared/mocks"',
            "\tif err != nil { return err }",
          ],
          [
            '\t"example.com/svc/internal/bulkupdate/mocks"',
            "\tif err != nil { return mocks.Wrap(err) }",
          ],
        ),
      ),
    ).toBe(0);
  });
});
